import type { JevQuestion } from "./jev.js";
import {
  APPROVED_LABEL,
  DECLINED_LABEL,
  hasLabel,
  NEEDS_GROUPING_LABEL,
} from "./owner-map.js";
import { BARS } from "./triage-bars.js";

const CLASSIFICATIONS = {
  bug: "an internal failure that settings, configuration, and platform limits do not explain",
  feature_request:
    "the customer asks for a new capability or for a limit to be lifted, whatever its feasibility",
  platform_limitation:
    "expected behaviour, or a provider, billing, entitlement, or plan limit, and the customer asks for nothing to be built or lifted",
  user_error:
    "settings, configuration, or something support can explain or follow up on, and the customer asks for nothing to be built",
} as const;

const CLASSIFICATION_NAMES = {
  bug: "Bug",
  feature_request: "Feature Request",
  platform_limitation: "Platform Limitation",
  user_error: "User Error",
} as const;
const EXPLANATIONS = new Set(["platform_limitation", "user_error"]);
export type TriageClassification =
  (typeof CLASSIFICATION_NAMES)[keyof typeof CLASSIFICATION_NAMES];

export const classificationQuestion = (): JevQuestion => ({
  criteria: { ...CLASSIFICATIONS },
  instructions:
    "Given the evidence, which one classification fits the root cause? Rule out settings, configuration, permissions, billing, provider limits, and expected behaviour before calling it a bug. Any ask for a new capability or a lifted limit is a Feature Request, even when a provider or plan limit causes it and even when it may never be built.",
  type: "choice",
});

/**
 * The classification code acts on. A person's decision comes first: a
 * Declined ticket stays a declined feature request whatever retriage finds,
 * and an Approved one keeps its feature routing over an explanation. Then
 * Feature Request fails open: an explanation Jev is not sure of (below
 * `BARS.closeExplanation`, however low) would close a ticket nobody saw, so
 * it stays a feature request (ENG-15932).
 */
export const settleClassification = (
  pick: { choice: string; confidence: number },
  ticketLabels: readonly string[],
  notes: string[]
): TriageClassification => {
  const named =
    CLASSIFICATION_NAMES[pick.choice as keyof typeof CLASSIFICATION_NAMES];
  if (hasLabel(ticketLabels, DECLINED_LABEL)) {
    if (named !== "Feature Request") {
      notes.push(
        `A person declined this feature request (${DECLINED_LABEL}), so it keeps that decision instead of routing as ${named}.`
      );
    }
    return "Feature Request";
  }
  if (!EXPLANATIONS.has(pick.choice)) {
    return named;
  }
  if (hasLabel(ticketLabels, APPROVED_LABEL)) {
    notes.push(
      `A person approved this feature request (${APPROVED_LABEL}), so it keeps that decision instead of closing as ${named}.`
    );
    return "Feature Request";
  }
  if (pick.confidence < BARS.closeExplanation) {
    notes.push(
      `${named} was below ${BARS.closeExplanation}, too unsure to close the ticket, so it stays open as a Feature Request for James to see.`
    );
    return "Feature Request";
  }
  return named;
};

const CLOSING_STATES = ["Canceled", "Duplicate"];

/** An explanation that closes carries the grouping label, so repeat confusion is counted. */
export const groupingLabel = (
  classification: TriageClassification,
  state: string
): string[] =>
  (classification === "User Error" ||
    classification === "Platform Limitation") &&
  CLOSING_STATES.includes(state)
    ? [NEEDS_GROUPING_LABEL]
    : [];

/** A feature request never closes on a match: it stays open, related to it. */
export const splitMatch = <T extends { candidate: { identifier: string } }>(
  classification: TriageClassification,
  found: T | undefined
): { duplicate: T | undefined; related: string | null } =>
  classification === "Feature Request"
    ? { duplicate: undefined, related: found?.candidate.identifier ?? null }
    : { duplicate: found, related: null };

/** The route fields a match adds: a duplicate inherits its owner, a related report only links. */
export const matchRoute = (
  related: string | null,
  duplicateOf: string | undefined
): {
  duplicateOf?: string;
  inheritAssigneeFrom?: string;
  relatedTo?: string;
} => {
  if (related) {
    return { relatedTo: related };
  }
  return duplicateOf ? { duplicateOf, inheritAssigneeFrom: duplicateOf } : {};
};
