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

/** What a critic call was sent to review, read from its message. */
export interface CriticPacket {
  commit: string | null;
  documentId: string | null;
  /** The issue's decision generation when the critic was dispatched. */
  generation?: number;
  issue: string;
  updatedAt: string | null;
}

export const criticTaskPackets = defineState<Record<string, CriticPacket>>(
  "foreman.criticTaskPackets",
  () => ({})
);

/**
 * One review cycle per decision: `ran` says the critic settled after the
 * latest decision, `reviews` counts this cycle's reviews, `last` is how the
 * latest one counted, and `generation` counts the issue's decisions, so a
 * critic dispatched for an earlier one is recognised when it settles.
 */
export interface CriticRounds {
  generation?: number;
  last: CriticCount | null;
  objections: number;
  ran: boolean;
  reviews: number;
}

export const criticRounds = defineState<Record<string, CriticRounds>>(
  "foreman.criticRounds",
  () => ({})
);

export const CRITIC_OBJECTION_LIMIT = 2;
export const CRITIC_REVIEW_LIMIT = 2;

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
      generation: rounds[issue]?.generation ?? 0,
      last: counted,
      objections: nextObjections(rounds[issue]?.objections ?? 0, counted),
      ran: true,
      reviews: (rounds[issue]?.reviews ?? 0) + 1,
    },
  };
}

const generationOf = (
  rounds: Readonly<Record<string, CriticRounds>>,
  issue: string
): number => rounds[issue]?.generation ?? 0;

export const stampCriticPacket = (
  rounds: Readonly<Record<string, CriticRounds>>,
  packet: CriticPacket
): CriticPacket => ({
  ...packet,
  generation: generationOf(rounds, packet.issue),
});

/**
 * Settles a critic result into its issue's rounds, unless it was dispatched
 * for an earlier decision: that result is stale and changes nothing, so the
 * newer decision still needs its own review.
 */
export function settleCriticPacket(
  rounds: Readonly<Record<string, CriticRounds>>,
  packet: CriticPacket,
  counted: CriticCount
): { rounds: Record<string, CriticRounds>; stale: boolean } {
  if ((packet.generation ?? 0) !== generationOf(rounds, packet.issue)) {
    return { rounds: { ...rounds }, stale: true };
  }
  return {
    rounds: settleCriticRound(rounds, packet.issue, counted),
    stale: false,
  };
}

/**
 * Whether a decision is the one adjudication of a review that just settled:
 * an objection that has not blocked, or a first review that failed. Any
 * other decision starts a new cycle with its own reviews.
 */
const adjudicates = (
  rounds: Readonly<Record<string, CriticRounds>>,
  issue: string
): boolean => {
  const prior = rounds[issue];
  if (!prior?.ran || criticBlocked(rounds, issue)) {
    return false;
  }
  return (
    prior.last === "objection" ||
    (prior.last === "failed" && prior.reviews < CRITIC_REVIEW_LIMIT)
  );
};

export function reviewCycleAfterDecision(
  rounds: Readonly<Record<string, CriticRounds>>,
  issue: string
): Record<string, CriticRounds> {
  const prior = rounds[issue];
  const generation = generationOf(rounds, issue) + 1;
  return {
    ...rounds,
    [issue]:
      prior && adjudicates(rounds, issue)
        ? { ...prior, generation, ran: false }
        : { generation, last: null, objections: 0, ran: false, reviews: 0 },
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

const statusOnly = (input: RouteInput & Record<string, unknown>): boolean =>
  typeof input.state === "string" &&
  Object.entries(input).every(
    ([key, value]) => key === "issue" || key === "state" || value === undefined
  );

const awaitingReview = (
  decisions: Readonly<Record<string, LatestTriageDecision>>,
  rounds: Readonly<Record<string, CriticRounds>>,
  issue: string
): boolean => {
  const round = rounds[issue];
  return (
    decisions[issue]?.closureReview === true &&
    !round?.ran &&
    (round?.reviews ?? 0) < CRITIC_REVIEW_LIMIT
  );
};

export function routeRefusal(
  decisions: Readonly<Record<string, LatestTriageDecision>>,
  rounds: Readonly<Record<string, CriticRounds>>,
  input: RouteInput & Record<string, unknown>,
  options: { statusRequest?: boolean } = {}
): string | null {
  if (options.statusRequest && statusOnly(input)) {
    return null;
  }
  if (criticBlocked(rounds, input.issue)) {
    return supportOwnerOnly(input)
      ? null
      : `The critic objected to ${input.issue} twice, so it is not routed. Leave its state, priority, labels and project as they are, record the objections in the investigation document, and call route_ticket with only issue and assignee set to ${SUPPORT_OWNER}, who takes it without a label change.`;
  }
  if (ownerOnly(input)) {
    return null;
  }
  if (awaitingReview(decisions, rounds, input.issue)) {
    return `${input.issue} is a closure or duplicate that needs the critic's second check first. Delegate to the critic with a first line of exactly "Source issue: ${input.issue}" and the Document, Document updatedAt and Commit lines critic-review.md names, then route once it settles.`;
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

/**
 * Records a new decision for its issue, triage or billing alike: it replaces
 * the latest decision and advances the issue's decision generation, so a
 * critic dispatched for an earlier decision settles as stale.
 */
export function recordDecision(
  decisions: Readonly<Record<string, LatestTriageDecision>>,
  rounds: Readonly<Record<string, CriticRounds>>,
  decision: LatestTriageDecision
) {
  return {
    ...settleDecision(decisions, decision),
    rounds: reviewCycleAfterDecision(rounds, decision.issue),
  };
}

/** Applies a settled critic result, unless it is stale for its issue. */
export function applyCriticSettlement(
  decisions: Readonly<Record<string, LatestTriageDecision>>,
  rounds: Readonly<Record<string, CriticRounds>>,
  packet: CriticPacket,
  counted: CriticCount
): {
  decisions: Record<string, LatestTriageDecision>;
  rounds: Record<string, CriticRounds>;
  stale: boolean;
} {
  const settled = settleCriticPacket(rounds, packet, counted);
  return {
    decisions: settled.stale
      ? { ...decisions }
      : blockedDecision(decisions, settled.rounds, packet.issue),
    rounds: settled.rounds,
    stale: settled.stale,
  };
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

const PACKET_LINE =
  /^\**(Document updatedAt|Document|Commit)\**:\**\s*`?([^`\s]+)`?\.?$/iu;

export function criticTaskPacket(input: unknown): CriticPacket | null {
  const issue = criticTaskIssue(input);
  if (!issue) {
    return null;
  }
  const fields = new Map<string, string>();
  for (const line of String((input as { message: string }).message).split(
    "\n"
  )) {
    const match = PACKET_LINE.exec(line.trim());
    if (match?.[1] && match[2] && !fields.has(match[1].toLowerCase())) {
      fields.set(match[1].toLowerCase(), match[2]);
    }
  }
  return {
    commit: fields.get("commit") ?? null,
    documentId: fields.get("document") ?? null,
    issue,
    updatedAt: fields.get("document updatedat") ?? null,
  };
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
  reviewed: z
    .object({
      commit: z.string(),
      document_id: z.string(),
      document_updated_at: z.string(),
      issue_id: z.string(),
    })
    .optional(),
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

const PINNED_COMMIT = /^[0-9a-f]{40}$/iu;

const echoed = (value: string): string =>
  value.replaceAll("`", "").trim().toUpperCase();

const completeApproval = (reply: CriticReply): boolean => {
  const slugs = new Set(reply.criteria_results.map((entry) => entry.criterion));
  return (
    reply.blocking_findings.length === 0 &&
    reply.criteria_results.length === CRITIC_CRITERIA.length &&
    slugs.size === CRITIC_CRITERIA.length &&
    reply.criteria_results.every((entry) => entry.result !== "FAIL")
  );
};

const sameEcho = (echo: string, sent: string | null): boolean =>
  sent !== null && echoed(echo) === echoed(sent);

/**
 * What a critic result counts as under critic-review.md step 5: an approval
 * only when it is complete, a failure when the review could not start or did
 * not review the packet it was sent (ticket, document, version and pinned
 * commit), and an objection otherwise.
 */
export function countCriticReply(
  reply: CriticReply,
  packet: CriticPacket | null
): CriticCount {
  const { reviewed } = reply;
  if (
    reply.criteria_results.length === 0 ||
    !(reviewed && packet) ||
    !PINNED_COMMIT.test(echoed(reviewed.commit)) ||
    !sameEcho(reviewed.issue_id, packet.issue) ||
    !sameEcho(reviewed.commit, packet.commit) ||
    !sameEcho(reviewed.document_id, packet.documentId) ||
    !sameEcho(reviewed.document_updated_at, packet.updatedAt)
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
  packet: CriticPacket | null = null
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
    counted: countCriticReply(parsed.data, packet),
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

export const criticVerdictIssue = <T>(
  bindings: Readonly<Record<string, T>>,
  callId: string
): T | null => bindings[callId] ?? null;

export const assigneeKind = (input: {
  assignee?: string;
  inheritAssigneeFrom?: string;
}) => {
  if (input.inheritAssigneeFrom) {
    return "inherited";
  }
  return input.assignee ? "named" : "none";
};
