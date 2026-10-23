import { defineState } from "eve/context";
import { z } from "zod";
import { CRITIC_CRITERIA, CRITIC_VERDICTS } from "../subagents/critic/agent.js";
import type { TriageDecision } from "./jev-decisions.js";

/**
 * Countable triage outcomes (ENG-16049). Every line carries the issue id, so
 * verdicts and later corrections can be counted per ticket. `decide_triage`
 * logs `triage.decision` each time it settles (`decide`, then `adjudicate`
 * when the critic's adjudication re-runs it), unproven outcomes included, and
 * keeps the latest decision per issue; `route_ticket` logs a `route` line for
 * every routed issue, with `code` `skill_fallback` when no Jev decision
 * exists for it (the skill decided after a Jev failure) and `billing` for a
 * `decide_billing` route. `decide_billing` keeps its decision per issue beside
 * the triage ones, so the later of the two for an issue wins; one made before
 * its ticket exists waits and binds to the first ticket routed to match it.
 * The root's hook logs `critic.verdict` against
 * the issue named on the dispatch's first line, and logs nothing for a
 * critic call that named none.
 */
export interface LatestTriageDecision {
  classification: string | null;
  issue: string;
  outcome: "route" | "unproven";
  path: string | null;
  route?: BillingRoute;
}

export const triageDecisions = defineState<
  Record<string, LatestTriageDecision>
>("foreman.triageDecisions", () => ({}));

export const BILLING_PATH = "Support/Financial";

export interface BillingRoute {
  assignee: string;
  project: string;
}

export const billingRoutes = defineState<BillingRoute | null>(
  "foreman.billingRoute",
  () => null
);

export const criticTaskIssues = defineState<Record<string, string>>(
  "foreman.criticTaskIssues",
  () => ({})
);

export function settleDecision(
  decisions: Readonly<Record<string, LatestTriageDecision>>,
  decision: LatestTriageDecision
) {
  return {
    decisions: { ...decisions, [decision.issue]: decision },
    stage:
      decisions[decision.issue] && !decisions[decision.issue].route
        ? "adjudicate"
        : "decide",
  } as const;
}

export function billingDecisionFields(
  issue: string,
  route: BillingRoute
): LatestTriageDecision {
  return {
    classification: null,
    issue,
    outcome: "route",
    path: BILLING_PATH,
    route,
  };
}

const SOURCE_LINE = /^\**Source issue:\**\s*`?([A-Z]{2,10}-\d{1,9})`?\.?\**$/u;

export function criticTaskIssue(input: unknown): string | null {
  const message = (input as { message?: unknown } | null)?.message;
  if (typeof message !== "string") {
    return null;
  }
  return SOURCE_LINE.exec(message.split("\n", 1)[0]?.trim() ?? "")?.[1] ?? null;
}

export function decisionFields(
  issue: string,
  decision: TriageDecision
): LatestTriageDecision {
  return decision.outcome === "route"
    ? {
        classification: decision.classification,
        issue,
        outcome: "route",
        path: decision.path,
      }
    : { classification: null, issue, outcome: "unproven", path: null };
}

const criticReply = z.object({
  blocking_findings: z.array(z.unknown()),
  criteria_results: z.array(
    z.object({ criterion: z.enum(CRITIC_CRITERIA), result: z.string() })
  ),
  verdict: z.enum(CRITIC_VERDICTS),
});

export interface CriticVerdictFields {
  blockingFindings: number | null;
  failedCriteria: number | null;
  verdict: (typeof CRITIC_VERDICTS)[number] | "failed";
}

/**
 * Reads the critic's settled output. A delegation error, a cancellation, or a
 * reply that doesn't match the critic's contract is a failed review.
 */
export function criticVerdictFields(
  status: string,
  output: unknown
): CriticVerdictFields {
  const failed = {
    blockingFindings: null,
    failedCriteria: null,
    verdict: "failed",
  } as const;
  if (status !== "completed") {
    return failed;
  }
  let value = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return failed;
    }
  }
  const parsed = criticReply.safeParse(value);
  if (!parsed.success) {
    return failed;
  }
  return {
    blockingFindings: parsed.data.blocking_findings.length,
    failedCriteria: parsed.data.criteria_results.filter(
      (entry) => entry.result === "FAIL"
    ).length,
    verdict: parsed.data.verdict,
  };
}

interface RouteInput {
  assignee?: string;
  duplicateOf?: string;
  inheritAssigneeFrom?: string;
  issue: string;
  project?: string;
}

export function routeDecisionEvent(
  decisions: Readonly<Record<string, LatestTriageDecision>>,
  input: RouteInput,
  pendingBilling: BillingRoute | null = null
) {
  const decision = decisions[input.issue];
  const triage = decision && !decision.route ? decision : undefined;
  const billing = decision ? decision.route : pendingBilling;
  const billed =
    !triage &&
    billing !== undefined &&
    billing !== null &&
    input.project === billing.project &&
    input.assignee === billing.assignee;
  let code: string | null = null;
  if (!triage) {
    code = billed ? "billing" : "skill_fallback";
  }
  let outcome = triage?.outcome ?? "skill";
  if (billed) {
    outcome = "route";
  }
  return {
    assigneeKind: assigneeKind(input),
    classification: triage?.classification ?? null,
    code,
    decision: "route",
    duplicateOf: input.duplicateOf ?? null,
    issue: input.issue,
    outcome,
    path: triage?.path ?? (billed ? BILLING_PATH : null),
    project: input.project ?? null,
  };
}

export function settleRoute(
  decisions: Readonly<Record<string, LatestTriageDecision>>,
  input: RouteInput,
  pendingBilling: BillingRoute | null
) {
  const event = routeDecisionEvent(decisions, input, pendingBilling);
  const binds =
    event.code === "billing" &&
    pendingBilling !== null &&
    !decisions[input.issue];
  return {
    decisions: binds
      ? {
          ...decisions,
          [input.issue]: billingDecisionFields(input.issue, pendingBilling),
        }
      : decisions,
    event,
    pendingBilling: binds ? null : pendingBilling,
  };
}

export const criticVerdictIssue = (
  bindings: Readonly<Record<string, string>>,
  callId: string
): string | null => bindings[callId] ?? null;

/** The route's assignee as a kind, never a person's name in the log. */
export const assigneeKind = (input: {
  assignee?: string;
  inheritAssigneeFrom?: string;
}) => {
  if (input.inheritAssigneeFrom) {
    return "inherited";
  }
  return input.assignee ? "named" : "none";
};
