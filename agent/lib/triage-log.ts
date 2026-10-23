import { defineState } from "eve/context";
import { z } from "zod";
import { CRITIC_CRITERIA, CRITIC_VERDICTS } from "../subagents/critic/agent.js";
import type { TriageDecision } from "./jev-decisions.js";

export interface LatestTriageDecision {
  classification: string | null;
  closureReview?: boolean;
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

export interface CriticRounds {
  objections: number;
  ran: boolean;
}

export const criticRounds = defineState<Record<string, CriticRounds>>(
  "foreman.criticRounds",
  () => ({})
);

export const CRITIC_OBJECTION_LIMIT = 2;

export function nextObjections(
  before: number,
  verdict: CriticVerdictFields["verdict"]
): number {
  if (verdict === "APPROVE") {
    return 0;
  }
  return verdict === "failed" ? before : before + 1;
}

export function settleCriticRound(
  rounds: Readonly<Record<string, CriticRounds>>,
  issue: string,
  verdict: CriticVerdictFields["verdict"]
): Record<string, CriticRounds> {
  return {
    ...rounds,
    [issue]: {
      objections: nextObjections(rounds[issue]?.objections ?? 0, verdict),
      ran: true,
    },
  };
}

export const criticBlocked = (
  rounds: Readonly<Record<string, CriticRounds>>,
  issue: string
): boolean => (rounds[issue]?.objections ?? 0) >= CRITIC_OBJECTION_LIMIT;

export function blockedDecision(
  decisions: Readonly<Record<string, LatestTriageDecision>>,
  rounds: Readonly<Record<string, CriticRounds>>,
  issue: string
): Record<string, LatestTriageDecision> {
  return criticBlocked(rounds, issue)
    ? {
        ...decisions,
        [issue]: {
          classification: null,
          issue,
          outcome: "unproven",
          path: null,
        },
      }
    : { ...decisions };
}

const ownerOnly = (input: RouteInput & Record<string, unknown>): boolean =>
  Object.entries(input).every(
    ([key, value]) =>
      key === "issue" || key === "assignee" || value === undefined
  );

export function routeRefusal(
  decisions: Readonly<Record<string, LatestTriageDecision>>,
  rounds: Readonly<Record<string, CriticRounds>>,
  input: RouteInput & Record<string, unknown>
): string | null {
  if (ownerOnly(input)) {
    return null;
  }
  if (criticBlocked(rounds, input.issue)) {
    return `The critic objected to ${input.issue} twice, so it is not routed. Leave its state, priority, labels and project as they are, record the objections in the investigation document, and call route_ticket with only issue and assignee set to the area owner.`;
  }
  if (decisions[input.issue]?.closureReview && !rounds[input.issue]?.ran) {
    return `${input.issue} is a closure or duplicate that needs the critic's second check first. Delegate to the critic with a first line of exactly "Source issue: ${input.issue}", then route once it settles.`;
  }
  return null;
}

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
        closureReview:
          decision.review.required && decision.review.kind !== "bug",
        issue,
        outcome: "route",
        path: decision.path,
      }
    : { classification: null, issue, outcome: "unproven", path: null };
}

export const confidenceFields = (decision: TriageDecision) => ({
  classificationConfidence: decision.confidence.classification,
  pathConfidence: decision.confidence.path,
  reviewKind: decision.review.kind,
  reviewRequired: decision.review.required,
  verdictConfidence: decision.confidence.verdict,
});

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
