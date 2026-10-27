import { probabilityOf } from "./jev.js";
import type {
  Answers,
  DuplicateMatch,
  HandlingPath,
  TriageClassification,
  TriageInput,
} from "./jev-decisions.js";

/**
 * The critic's second check and the billing gate for inbox errors
 * (ENG-16055): which decisions need a second check, and whether an inbox
 * error is billing before it may be called a code bug.
 */

export interface BillingFacts {
  checkedAt: string;
  domainsLive: boolean | null;
  organizationId: string;
  paymentsFailing: boolean | null;
  source: string;
  subscriptionPaid: boolean | null;
}

export const REVIEW_KINDS = [
  "bug",
  "duplicate",
  "platform_limitation",
  "user_error",
  "billing_inbox",
] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export interface ReviewDecision {
  kind: ReviewKind | null;
  reason: string;
  required: boolean;
}

export interface TriageConfidence {
  classification: number;
  path: number;
  verdict: number;
}

export interface BillingCheck {
  failures: string[];
  outcome: "failed" | "passed";
}

const BILLING_FACTS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BILLING_FACTS_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const COULD_NOT_RUN = /could not run/iu;

const BILLING_GAP =
  "A billing check for the inbox error: the subscription is paid, payments are not failing, and the domains are live at the supplier, read now for this workspace.";

export const inspectBillingFacts = (
  input: TriageInput,
  now: Date
): { gaps: string[] } | BillingCheck => {
  const facts = input.billingFacts;
  if (!facts) {
    return { gaps: [BILLING_GAP] };
  }
  const readAt = Date.parse(facts.checkedAt);
  const age = now.getTime() - readAt;
  if (
    Number.isNaN(readAt) ||
    age > BILLING_FACTS_MAX_AGE_MS ||
    age < -BILLING_FACTS_CLOCK_SKEW_MS
  ) {
    return { gaps: [`${BILLING_GAP} The facts given are stale or undated.`] };
  }
  if (!input.organizationId || facts.organizationId !== input.organizationId) {
    return {
      gaps: [`${BILLING_GAP} The facts are not tied to the pinned workspace.`],
    };
  }
  const failures = [
    ...(facts.subscriptionPaid === false
      ? ["The subscription is not paid."]
      : []),
    ...(facts.paymentsFailing === true ? ["Payments are failing."] : []),
    ...(facts.domainsLive === false
      ? ["The domains are not live at the supplier."]
      : []),
  ];
  if (failures.length > 0) {
    return { failures, outcome: "failed" };
  }
  const unknown = [
    facts.subscriptionPaid === null ? "whether the subscription is paid" : null,
    facts.paymentsFailing === null ? "whether payments are failing" : null,
    facts.domainsLive === null ? "whether the domains are live" : null,
  ].filter((gap): gap is string => gap !== null);
  return unknown.length > 0
    ? { gaps: [`${BILLING_GAP} Not known: ${unknown.join(", ")}.`] }
    : { failures: [], outcome: "passed" };
};

export const UNPROVEN_REVIEW: ReviewDecision = {
  kind: null,
  reason: "the ticket stays open as unproven",
  required: false,
};

export const BILLING_INBOX_REVIEW: ReviewDecision = {
  kind: "billing_inbox",
  reason: "an inbox error was set aside as billing, not code",
  required: true,
};

interface InboxGateContext {
  answers: Answers;
  classification: TriageClassification;
  duplicate: DuplicateMatch;
  input: TriageInput;
  notes: string[];
  now: Date;
  signal: number;
}

export type InboxGate =
  | { billingCheck: BillingCheck; kind: "billing" | "checked" }
  | { kind: "unproven"; missing: string[] }
  | null;

export const gateInboxError = (context: InboxGateContext): InboxGate => {
  const { answers, classification, duplicate, input, notes } = context;
  if (
    probabilityOf(answers.inbox_error) < context.signal ||
    !(classification === "Bug" || duplicate)
  ) {
    return null;
  }
  const inspected = inspectBillingFacts(input, context.now);
  if ("gaps" in inspected) {
    notes.push(
      "An inbox error cannot be called a bug or linked to a master before the billing check."
    );
    return { kind: "unproven", missing: inspected.gaps };
  }
  if (inspected.outcome === "passed") {
    notes.push("The billing check passed: paid, not failing, domains live.");
    return { billingCheck: inspected, kind: "checked" };
  }
  notes.push(
    `The inbox error is billing, not a code bug: ${inspected.failures.join(" ")}`
  );
  if (duplicate) {
    notes.push(
      `The match with ${duplicate.candidate.identifier} was set aside.`
    );
  }
  return { billingCheck: inspected, kind: "billing" };
};

export const reviewOf = (
  input: TriageInput,
  answers: Answers,
  settled: {
    classification: TriageClassification;
    closes: boolean;
    duplicate: boolean;
    path: HandlingPath;
    signal: number;
  }
): ReviewDecision => {
  const { classification, closes, duplicate, path } = settled;
  if (duplicate) {
    return {
      kind: "duplicate",
      reason: "a duplicate closes this ticket on another ticket's cause",
      required: true,
    };
  }
  if (classification === "Bug") {
    return {
      kind: "bug",
      reason: "a Bug is routed to engineering",
      required: true,
    };
  }
  if (
    classification === "Platform Limitation" ||
    path === "Platform Limitation"
  ) {
    return {
      kind: "platform_limitation",
      reason: "a platform limitation closes the ticket as expected behaviour",
      required: true,
    };
  }
  const laneGap =
    (input.unavailableLanes?.length ?? 0) > 0 ||
    COULD_NOT_RUN.test(input.evidence);
  if (closes && laneGap) {
    return {
      kind: "user_error",
      reason:
        "an evidence lane could not run, so the user error rests on missing evidence",
      required: true,
    };
  }
  if (closes && probabilityOf(answers.customer_saw_failure) >= settled.signal) {
    return {
      kind: "user_error",
      reason: "the customer saw a failure that the user error explains away",
      required: true,
    };
  }
  let reason =
    "every evidence lane ran and the report names no failure the customer saw";
  if (path === "Resolved by triage") {
    reason = "the already-fixed check for this path ships separately";
  } else if (!closes) {
    reason = "the ticket stays open for a person";
  }
  return { kind: null, reason, required: false };
};
