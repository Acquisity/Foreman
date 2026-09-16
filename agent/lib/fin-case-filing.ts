import { z } from "zod";
import {
  assertFinCaseRouting,
  assertFinCaseSource,
  type FinCaseDecision,
  type FinCaseOutcome,
  finCaseIssue,
  finCaseMarker,
  finCaseSource,
  formatFinCustomerReport,
} from "./fin-case.js";
import {
  bindFinCase,
  claimFinCase,
  type FinCase,
  finishFinCase,
  reserveFinCaseCreation,
  reserveFinCaseDocument,
} from "./fin-case-store.js";
import type { FinContext } from "./fin-scope.js";
import { providerData } from "./support/conversation.js";

export type FinLinearCall = (
  operation:
    | "get_issue"
    | "list_issues"
    | "save_issue"
    | "get_document"
    | "save_document",
  input: Record<string, unknown>
) => Promise<unknown>;
const issueIdentifier = /^ENG-\d+$/;
const failed: FinCaseOutcome = {
  message:
    "The ticket outcome could not be verified. Do not claim success or create a replacement.",
  outcome: "failed",
};
const classificationLabels = (classification: string) =>
  classification === "Not settled" ? [] : [classification];
const store = {
  bind: bindFinCase,
  claim: claimFinCase,
  finish: finishFinCase,
  reserveCreation: reserveFinCaseCreation,
  reserveDocument: reserveFinCaseDocument,
};

/** Provider results remain server-side until source and routing checks have passed. */
export async function readFinCaseIssue(
  call: FinLinearCall,
  id: string,
  scope: FinContext
) {
  const issue = finCaseIssue.parse(
    providerData(await call("get_issue", { id }))
  );
  if (issue.id !== id) {
    throw new Error("Ticket identity mismatch.");
  }
  assertFinCaseSource(issue, scope);
  return issue;
}

async function sourceMatches(call: FinLinearCall, record: FinCase) {
  const result = z
    .object({
      hasNextPage: z.boolean(),
      issues: z.array(
        z.object({
          id: z.string().regex(issueIdentifier),
        })
      ),
    })
    .parse(
      providerData(
        await call("list_issues", {
          fields: ["id"],
          includeArchived: true,
          limit: 100,
          query: record.scope.conversationId,
          team: "Engineering Team",
        })
      )
    );
  if (result.hasNextPage) {
    throw new Error("Source matching is incomplete.");
  }
  return result.issues;
}

function report(record: FinCase) {
  if (record.decision.action !== "file") {
    throw new Error("No filing decision.");
  }
  return `${formatFinCustomerReport(record.decision.summary)}\n\n## Classification\n\n${record.decision.classification}\n\nVerified workspace: ${record.scope.organizationName} (${record.scope.organizationSlug}). Organization ID: ${record.scope.organizationId}. Scope is server-owned and limited to this workspace. No global blast radius was checked.\n\n${finCaseMarker(record.id)}\nIntercom source: ${finCaseSource(record.scope)}`;
}

async function verifyDocument(
  call: FinLinearCall,
  record: FinCase,
  persistence: typeof store
) {
  const issue = await readFinCaseIssue(
    call,
    record.issue_id ?? "",
    record.scope
  );
  let documents = issue.documents.filter(
    (entry) => entry.title === "Triage investigation"
  );
  if (
    !documents.length &&
    record.created_here &&
    (await persistence.reserveDocument(record.id))
  ) {
    await call("save_document", {
      content: report(record),
      issue: issue.id,
      title: "Triage investigation",
    });
    documents = (
      await readFinCaseIssue(call, issue.id, record.scope)
    ).documents.filter((entry) => entry.title === "Triage investigation");
  }
  if (documents.length !== 1) {
    throw new Error("Investigation document is unconfirmed.");
  }
  const document = z
    .object({ content: z.string().min(1).max(100_000) })
    .parse(providerData(await call("get_document", { id: documents[0].id })));
  if (record.created_here && document.content !== report(record)) {
    throw new Error("Investigation document differs.");
  }
}

/** INSERT owns the one creation attempt. Replays reconcile but never repeat creation. */
export async function fileFinCase(
  scope: FinContext,
  sessionId: string,
  decision: FinCaseDecision,
  call: FinLinearCall,
  signal: AbortSignal,
  persistence = store
): Promise<FinCaseOutcome> {
  try {
    const claimed = await persistence.claim(scope, sessionId, decision);
    let { record } = claimed;
    if (record.outcome) {
      return record.outcome;
    }
    if (record.decision.action === "not-needed") {
      return await persistence.finish(record.id, {
        message: record.decision.reason,
        outcome: "not-needed",
      });
    }
    const input = record.decision;
    if (!record.issue_id) {
      const matches = await sourceMatches(call, record);
      if (matches.length > 1) {
        return failed;
      }
      if (matches.length === 1) {
        const issue = await readFinCaseIssue(call, matches[0].id, scope);
        record = await persistence.bind(
          record.id,
          issue.id,
          issue.description.includes(finCaseMarker(record.id))
        );
      } else if (await persistence.reserveCreation(record.id)) {
        const created = z
          .object({ id: z.string().regex(issueIdentifier) })
          .parse(
            providerData(
              await call("save_issue", {
                assignee: input.assignee,
                description: report(record),
                labels: [
                  "intercom-sourced",
                  "Customer reported",
                  ...classificationLabels(input.classification),
                ],
                links: [
                  { title: "Intercom conversation", url: finCaseSource(scope) },
                ],
                priority: input.priority,
                project: input.project,
                state: input.classification === "Bug" ? "Triage" : "Todo",
                team: "Engineering Team",
                title: input.title,
              })
            )
          );
        record = await persistence.bind(record.id, created.id, true);
      } else {
        // Absence from search is not proof a timed-out creation did not land.
        return failed;
      }
    }
    const issue = await readFinCaseIssue(call, record.issue_id ?? "", scope);
    assertFinCaseRouting(issue, input);
    await verifyDocument(call, record, persistence);
    return await persistence.finish(record.id, {
      identifier: issue.id,
      message: record.created_here
        ? "A ticket was opened for the team with the investigation findings."
        : "This report is already tracked by the team; no new ticket was created.",
      outcome: record.created_here ? "newly-created" : "already-tracked",
    });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return failed;
  }
}
