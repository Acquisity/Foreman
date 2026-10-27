import { defineState } from "eve/context";
import { z } from "zod";
import { CRITIC_CRITERIA, CRITIC_VERDICTS } from "../subagents/critic/agent.js";
import type { TriageDecision } from "./jev-decisions.js";
import { SUPPORT_OWNER } from "./owner-map.js";

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

export function nextObjections(before: number, counted: CriticCount): number {
  if (counted === "approve") {
    return 0;
  }
  return counted === "failed" ? before : before + 1;
}

export function settleCriticRound(
  rounds: Readonly<Record<string, CriticRounds>>,
  issue: string,
  counted: CriticCount
): Record<string, CriticRounds> {
  return {
    ...rounds,
    [issue]: {
      objections: nextObjections(rounds[issue]?.objections ?? 0, counted),
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

const supportOwnerOnly = (input: RouteInput & Record<string, unknown>) =>
  ownerOnly(input) &&
  input.assignee?.trim().toLowerCase() === SUPPORT_OWNER.toLowerCase();

export function routeRefusal(
  decisions: Readonly<Record<string, LatestTriageDecision>>,
  rounds: Readonly<Record<string, CriticRounds>>,
  input: RouteInput & Record<string, unknown>
): string | null {
  if (criticBlocked(rounds, input.issue)) {
    return supportOwnerOnly(input)
      ? null
      : `The critic objected to ${input.issue} twice, so it is not routed. Leave its state, priority, labels and project as they are, record the objections in the investigation document, and call route_ticket with only issue and assignee set to ${SUPPORT_OWNER}, who takes it without a label change.`;
  }
  if (ownerOnly(input)) {
    return null;
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
  reviewed: z.object({ commit: z.string(), issue_id: z.string() }).optional(),
  verdict: z.enum(CRITIC_VERDICTS),
});
type CriticReply = z.infer<typeof criticReply>;

export const CRITIC_COUNTS = ["approve", "objection", "failed"] as const;
export type CriticCount = (typeof CRITIC_COUNTS)[number];

export const criticVerdictSchema = z.strictObject({
  blockingFindings: z.int().nonnegative().nullable(),
  counted: z.enum(CRITIC_COUNTS),
  failedCriteria: z.int().nonnegative().nullable(),
  verdict: z.enum([...CRITIC_VERDICTS, "failed"]),
});
export type CriticVerdictFields = z.infer<typeof criticVerdictSchema>;

const PINNED_COMMIT = /^[0-9a-f]{40}$/u;

const completeApproval = (reply: CriticReply): boolean => {
  const slugs = new Set(reply.criteria_results.map((entry) => entry.criterion));
  return (
    reply.blocking_findings.length === 0 &&
    reply.criteria_results.length === CRITIC_CRITERIA.length &&
    slugs.size === CRITIC_CRITERIA.length &&
    reply.criteria_results.every((entry) => entry.result !== "FAIL")
  );
};

/**
 * What a critic result counts as under critic-review.md step 5: an approval
 * only when it is complete, a failure when the review could not start, ran
 * unpinned or reviewed another ticket, and an objection otherwise.
 */
export function countCriticReply(
  reply: CriticReply,
  issue: string | null
): CriticCount {
  if (
    reply.criteria_results.length === 0 ||
    !reply.reviewed ||
    !PINNED_COMMIT.test(reply.reviewed.commit) ||
    (issue !== null && reply.reviewed.issue_id !== issue)
  ) {
    return "failed";
  }
  return reply.verdict === "APPROVE" && completeApproval(reply)
    ? "approve"
    : "objection";
}

export function criticVerdictFields(
  status: string,
  output: unknown,
  issue: string | null = null
): CriticVerdictFields {
  const failed = {
    blockingFindings: null,
    counted: "failed",
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
    counted: countCriticReply(parsed.data, issue),
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
