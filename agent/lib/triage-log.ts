import { defineState } from "eve/context";
import { z } from "zod";
import { CRITIC_CRITERIA, CRITIC_VERDICTS } from "../subagents/critic/agent.js";
import type { TriageDecision } from "./jev-decisions.js";

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

export const criticVerdictSchema = z.strictObject({
  blockingFindings: z.int().nonnegative().nullable(),
  failedCriteria: z.int().nonnegative().nullable(),
  verdict: z.enum([...CRITIC_VERDICTS, "failed"]),
});
export type CriticVerdictFields = z.infer<typeof criticVerdictSchema>;

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
  input: RouteInput
) {
  const decision = decisions[input.issue];
  const triage = decision && !decision.route ? decision : undefined;
  const billing = decision?.route;
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

export const criticVerdictIssue = (
  bindings: Readonly<Record<string, string>>,
  callId: string
): string | null => bindings[callId] ?? null;

export const assigneeKind = (input: {
  assignee?: string;
  inheritAssigneeFrom?: string;
}) => {
  if (input.inheritAssigneeFrom) {
    return "inherited";
  }
  return input.assignee ? "named" : "none";
};
