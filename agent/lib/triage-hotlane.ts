import { choiceOf, type JevAnswer } from "./jev.js";

export const HOTLANE_ROUTES = {
  hotlane:
    "current evidence confirms at least one of: a core workflow blocked or materially impaired; data lost, corrupted, exposed, or written to the wrong tenant; permissions, authentication, security, or privacy controls failing; paid work silently skipped or false success reported; customers actively charged or financially harmed incorrectly; material revenue loss, uncontrolled provider-cost burn, or customer-trust harm needing immediate containment; a high-frequency failure on a core path; or no safe workaround for a material customer outcome",
  needs_human_urgent:
    "the evidence points at one of those high-risk conditions, but a critical evidence lane was unavailable, so it cannot be confirmed",
  standard: "a confirmed defect that meets none of those conditions",
} as const;

export const HOTLANE_IMPACTS = {
  BLOCKED: "completely blocks the user's objective",
  DATA_OR_SECURITY_RISK: "risks data loss, corruption, security, or privacy",
  INCORRECT_RESULT: "produces materially incorrect results",
  MATERIAL_BUSINESS_HARM:
    "active revenue, provider-cost, or customer-trust harm",
  MATERIALLY_IMPAIRED: "materially impairs the user's objective",
  MONEY_IMPACT: "customers charged or financially harmed incorrectly",
  NON_CORE: "cosmetic, inconvenient, or a non-core edge case",
  SILENTLY_SKIPPED: "silently skips paid or expected work",
} as const;

export interface HotlaneDecision {
  impact: keyof typeof HOTLANE_IMPACTS | "UNCONFIRMED";
  notes: string[];
  proposedLabel: "fast-lane" | "none";
  route: "HOTLANE" | "NEEDS_HUMAN_URGENT" | "STANDARD_ENGINEERING";
}

/**
 * Whether a Bug is an incident. Route by impact, never by report count; a
 * hotlane call below the bar goes to a person rather than to routine work.
 */
export function resolveHotlane(
  answers: Record<string, JevAnswer>,
  incidentBar: number
): HotlaneDecision {
  const notes: string[] = [];
  const { choice, confidence } = choiceOf(answers.incident);
  let route: HotlaneDecision["route"] = "STANDARD_ENGINEERING";
  if (choice === "needs_human_urgent") {
    route = "NEEDS_HUMAN_URGENT";
  } else if (choice === "hotlane" && confidence >= incidentBar) {
    route = "HOTLANE";
  } else if (choice === "hotlane") {
    route = "NEEDS_HUMAN_URGENT";
    notes.push(
      "A hotlane condition was likely but not clear enough to confirm; a person confirms it."
    );
  }
  return {
    impact:
      route === "NEEDS_HUMAN_URGENT"
        ? "UNCONFIRMED"
        : (choiceOf(answers.incident_impact)
            .choice as keyof typeof HOTLANE_IMPACTS),
    notes,
    proposedLabel: route === "HOTLANE" ? "fast-lane" : "none",
    route,
  };
}
