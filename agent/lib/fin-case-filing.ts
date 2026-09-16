import { z } from "zod";
import {
  assertFinCaseRouting,
  assertFinCaseSource,
  FIN_CASE_TEAM,
  type FinCaseDecision,
  type FinCaseFiling,
  type FinCaseIssue,
  type FinCaseOutcome,
  finCaseFailed,
  finCaseIdentifier,
  finCaseIssue,
  finCaseLabels,
  finCaseList,
  finCaseSearch,
  finCaseSource,
  formatFinCustomerReport,
} from "./fin-case.js";
import type { FinContext } from "./fin-scope.js";

/** The only Linear surface this lane has. The caller decides which names it permits. */
export type FinLinearCall = (
  operation: "list_issues" | "save_issue" | "get_issue",
  input: Record<string, unknown>
) => Promise<unknown>;

const savedIssue = z.looseObject({ id: finCaseIdentifier });

const report = (scope: FinContext, decision: FinCaseFiling) =>
  [
    formatFinCustomerReport(decision.summary),
    `## Classification\n\n${decision.classification}`,
    `Verified workspace: ${scope.organizationName} (${scope.organizationSlug}), organization ID ${scope.organizationId}. This scope is server-owned and limited to this workspace, and no global blast radius was checked.`,
    `Intercom source: ${finCaseSource(scope)}`,
  ].join("\n\n");

const readCase = async (
  call: FinLinearCall,
  id: string
): Promise<FinCaseIssue> => finCaseIssue.parse(await call("get_issue", { id }));

/**
 * The Intercom conversation ID lives in the ticket body and its link, so Linear
 * itself answers whether a ticket already exists. Search first, create at most
 * once, and never retry the write.
 */
export async function fileFinCase(
  scope: FinContext,
  decision: FinCaseDecision,
  call: FinLinearCall,
  signal: AbortSignal
): Promise<FinCaseOutcome> {
  if (decision.action === "not-needed") {
    return { message: decision.reason, outcome: "not-needed" };
  }
  // Set only once this lane's own write landed, so a later verification failure
  // names the ticket it orphaned instead of leaving it unfindable.
  let created: string | undefined;
  try {
    const found = finCaseList.parse(
      await call("list_issues", finCaseSearch(scope))
    );
    // A truncated page cannot prove absence, and two matches cannot be told apart.
    if (found.hasNextPage || found.issues.length > 1) {
      return finCaseFailed;
    }
    const tracked = found.issues[0]?.id;
    if (tracked) {
      const issue = await readCase(call, tracked);
      // Source only: a ticket filed earlier has usually been re-triaged since.
      assertFinCaseSource(issue, scope);
      return {
        identifier: issue.id,
        message:
          "This report is already tracked by the team; no new ticket was created.",
        outcome: "already-tracked",
      };
    }
    const saved = savedIssue.parse(
      await call("save_issue", {
        assignee: decision.assignee,
        description: report(scope, decision),
        labels: finCaseLabels(decision.classification),
        links: [{ title: "Intercom conversation", url: finCaseSource(scope) }],
        priority: decision.priority,
        project: decision.project,
        state: decision.classification === "Bug" ? "Triage" : "Todo",
        team: FIN_CASE_TEAM,
        title: decision.title,
      })
    );
    created = saved.id;
    const issue = await readCase(call, saved.id);
    assertFinCaseSource(issue, scope);
    assertFinCaseRouting(issue, decision);
    return {
      identifier: issue.id,
      message:
        "A ticket was opened for the team with the investigation findings.",
      outcome: "newly-created",
    };
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return created ? { ...finCaseFailed, identifier: created } : finCaseFailed;
  }
}
