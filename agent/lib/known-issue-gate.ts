import { defineState } from "eve/context";
import type { PriorWorkDecision } from "./jev-decisions.js";
import { isSupportChatLink } from "./widget-support-report.js";
import { isWidgetFiledDescription } from "./widget-ticket-marker.js";

/**
 * What this session checked before a widget bug reaches Fixy (ENG-21101):
 * the known-issue searches, the prior-work decision, and the join. Only
 * `find_related_issues`, `decide_prior_work` and `route_ticket` write it, each
 * for the issue it names, and only `hand_to_fixy` reads it, so several
 * customers reporting one bug join its open issue instead of each starting a
 * Fixy run.
 */
export interface KnownIssueCheck {
  decision?: PriorWorkDecision | { failed: true };
  /** The last join route_ticket tried: grouping says whether it closed the report under a master. */
  join?: {
    error?: string;
    grouping?: "joined" | "needs-grouping" | null;
    target: string;
  };
  /** Each search scope run for this issue: its hits by identifier and state type, or null when it failed. */
  searches: Partial<
    Record<"duplicates" | "masters", Record<string, string> | null>
  >;
}

export const knownIssueChecks = defineState<Record<string, KnownIssueCheck>>(
  "foreman.knownIssueChecks",
  () => ({})
);

const key = (issue: string) => issue.trim().toUpperCase();

export const recordKnownIssueCheck = (
  issue: string,
  change: (check: KnownIssueCheck) => KnownIssueCheck
) =>
  knownIssueChecks.update((all) => ({
    ...all,
    [key(issue)]: change(all[key(issue)] ?? { searches: {} }),
  }));

export const checkFor = (
  checks: Record<string, KnownIssueCheck>,
  issue: string
): KnownIssueCheck | undefined => checks[key(issue)];

/** A ticket the support widget filed: its Support chat link, or the trailing Verified scope block of one filed before ENG-21100. */
export const isWidgetTicket = (ticket: {
  attachments: readonly { title: string; url: string }[];
  description: string | null;
}): boolean =>
  ticket.attachments.some(isSupportChatLink) ||
  isWidgetFiledDescription(ticket.description);

const isClosedType = (type: string) =>
  type === "completed" || type === "canceled";

const MATCH_WORDS = {
  not_relevant: "not relevant",
  partial_or_adjacent: "partial match",
  same_outcome: "same outcome",
  stale_or_superseded: "already fixed or decided",
} as const;

/** refusal set means nothing is written; notes go at the front of the handoff notes. */
export interface GateResult {
  notes: string[];
  refusal?: string;
}

const refuse = (refusal: string): GateResult => ({ notes: [], refusal });

/** The line for a decision naming a known issue: a refusal while it is open and no join was tried. */
const knownIssueLine = (
  known: string,
  knownIssueState: string | null,
  join: KnownIssueCheck["join"],
  also: string
): string | GateResult => {
  if (knownIssueState === null) {
    return `Same outcome as ${known}, whose state could not be read.${also}`;
  }
  if (isClosedType(knownIssueState)) {
    return `Same outcome as ${known}, which is already ${knownIssueState}: check whether this is a regression.${also}`;
  }
  if (join?.target !== known) {
    return refuse(
      `decide_prior_work found ${known}, an open known issue with the same outcome. Join it with route_ticket (state Duplicate, duplicateOf and inheritAssigneeFrom ${known}) instead of starting a new Fixy run. Hand it to Fixy only if that join is refused. Nothing was written.`
    );
  }
  const why = join.error
    ? "route_ticket refused the join"
    : "it has no open master to join";
  return `Same outcome as open ${known}, but ${why}: join it there if your look agrees.${also}`;
};

/** The note a recorded decision adds, or a refusal for an open known issue not yet joined. */
const decisionLine = (
  decision: PriorWorkDecision,
  knownIssueState: string | null,
  join: KnownIssueCheck["join"]
): string | GateResult | null => {
  const uncertain = decision.candidates
    .filter(
      (candidate) =>
        candidate.identifier !== decision.knownIssue &&
        candidate.match === "partial_or_adjacent"
    )
    .map((c) => `${c.identifier} (${MATCH_WORDS[c.match]})`)
    .join(", ");
  const known = decision.outcome === "known_issue" && decision.knownIssue;
  if (known) {
    const also = uncertain ? ` Also related: ${uncertain}.` : "";
    return knownIssueLine(known, knownIssueState, join, also);
  }
  return uncertain ? `Possible known issue: ${uncertain}.` : null;
};

/**
 * Whether a widget engineering handoff may start Fixy. It refuses until both
 * searches ran for this ticket and, when they found anything, the prior-work
 * decision; it refuses an open known issue that was not joined, and a report
 * already joined. Every uncertain outcome passes with a note naming the
 * candidate, so Fixy can join it once it has looked.
 */
export const knownIssueGate = (
  issue: string,
  check: KnownIssueCheck | undefined,
  ownState: string,
  knownIssueState: string | null
): GateResult => {
  if (ownState === "duplicate" || check?.join?.grouping === "joined") {
    return refuse(
      `${issue} already joined ${check?.join?.target ?? "a known issue"} as a duplicate, so Fixy works the known issue and no new run starts for this report. Do not hand it to Fixy.`
    );
  }
  const searches = check?.searches ?? {};
  const missing = (["masters", "duplicates"] as const).filter(
    (scope) => !(scope in searches)
  );
  if (missing.length > 0) {
    return refuse(
      `Before a widget bug goes to Fixy, check it against open known issues: call find_related_issues with issue ${issue} and scope ${missing.join(" and ")}, then decide_prior_work with issue ${issue} and the hits. Nothing was written.`
    );
  }
  const candidates = Object.keys({
    ...searches.masters,
    ...searches.duplicates,
  }).filter((hit) => hit !== issue.toUpperCase());
  const notes = Object.values(searches).includes(null)
    ? ["A known-issue search failed, so the report may match an open issue."]
    : [];
  const decision = check?.decision;
  if (candidates.length === 0) {
    return { notes };
  }
  if (!decision) {
    return refuse(
      `The known-issue searches found ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}. Call decide_prior_work with issue ${issue}, the report and those hits before handing it to Fixy. Nothing was written.`
    );
  }
  const line =
    "failed" in decision
      ? `Known-issue check undecided; possible matches: ${candidates.slice(0, 4).join(", ")}.`
      : decisionLine(decision, knownIssueState, check?.join);
  if (line !== null && typeof line !== "string") {
    return line;
  }
  return { notes: line ? [...notes, line] : notes };
};
