import { defineState } from "eve/context";
import type { CandidateMatch, PriorWorkDecision } from "./jev-decisions.js";
import { isSupportChatLink } from "./widget-support-report.js";
import { isWidgetFiledDescription } from "./widget-ticket-marker.js";

/**
 * What this session checked before a widget bug reaches Fixy (ENG-21101):
 * the known-issue searches, every prior-work judgment, and the join. Only
 * `find_related_issues`, `decide_prior_work` and `route_ticket` write it, each
 * for the issue it names, and only `hand_to_fixy` reads it, so several
 * customers reporting one bug join its open issue instead of each starting a
 * Fixy run.
 */
export interface KnownIssueCheck {
  /** A route_ticket call that asked for Duplicate under a match: its error when it was refused, and its grouping. */
  join?: {
    error?: string;
    grouping: "joined" | "needs-grouping" | null;
    target: string;
  };
  /** Every candidate judged, across decide_prior_work batches. */
  judged: Record<string, CandidateMatch>;
  /** Every known issue a batch named, first first, so a later fresh batch never hides one. */
  knownIssues: string[];
  /** Each search scope run for this issue: the identifiers it found, or null when it failed. */
  searches: Partial<Record<"duplicates" | "masters", string[] | null>>;
  /** A decide_prior_work batch failed, so some hits may be unjudged. */
  undecided?: boolean;
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
    [key(issue)]: change(
      all[key(issue)] ?? { judged: {}, knownIssues: [], searches: {} }
    ),
  }));

export const checkFor = (
  checks: Record<string, KnownIssueCheck>,
  issue: string
): KnownIssueCheck | undefined => checks[key(issue)];

/** Adds one decide_prior_work batch to the judgments already recorded. */
export const withDecision = (
  check: KnownIssueCheck,
  decision: PriorWorkDecision | null
): KnownIssueCheck => {
  if (!decision) {
    return { ...check, undecided: true };
  }
  const known =
    decision.outcome === "known_issue" && decision.knownIssue
      ? decision.knownIssue.toUpperCase()
      : null;
  return {
    ...check,
    judged: {
      ...check.judged,
      ...Object.fromEntries(
        decision.candidates.map((c) => [c.identifier.toUpperCase(), c.match])
      ),
    },
    knownIssues:
      known && !check.knownIssues.includes(known)
        ? [...check.knownIssues, known]
        : check.knownIssues,
  };
};

const isDuplicateState = (state: string | undefined) =>
  state?.trim().toLowerCase() === "duplicate";

/** Records a route_ticket call that asked to close the report as a Duplicate of a match; any other route is not a join and records nothing. */
export const recordJoin = (
  input: { duplicateOf?: string; issue: string; state?: string },
  result: { error?: string; grouping?: string | null }
) => {
  if (!(input.duplicateOf && isDuplicateState(input.state))) {
    return;
  }
  const target = input.duplicateOf.toUpperCase();
  recordKnownIssueCheck(input.issue, (check) => ({
    ...check,
    join: {
      error: result.error,
      grouping:
        result.grouping === "joined" || result.grouping === "needs-grouping"
          ? result.grouping
          : null,
      target,
    },
  }));
};

/** A ticket the support widget filed: its Support chat link, or the trailing Verified scope block of one filed before ENG-21100. */
export const isWidgetTicket = (ticket: {
  attachments: readonly { title: string; url: string }[];
  description: string | null;
}): boolean =>
  ticket.attachments.some(isSupportChatLink) ||
  isWidgetFiledDescription(ticket.description);

const MATCH_WORDS = {
  not_relevant: "not relevant",
  partial_or_adjacent: "partial match",
  same_outcome: "same outcome",
  stale_or_superseded: "already fixed or decided",
} as const;

/** How many uncertain candidates a note names. */
const NOTE_CANDIDATES = 3;

/** refusal set means nothing is written; notes go at the front of the handoff notes. */
export interface GateResult {
  notes: string[];
  refusal?: string;
}

const refuse = (refusal: string): GateResult => ({ notes: [], refusal });

/**
 * The known issue as the gate sees it: open when it or a parent up its chain
 * is still open, since route_ticket climbs to that open master to join.
 */
export type KnownIssueState = "closed" | "missing" | "open";

/** The line for the known issue: a refusal while it is open and no Duplicate join was tried. */
const knownIssueLine = (
  known: string,
  state: KnownIssueState,
  join: KnownIssueCheck["join"],
  also: string
): string | GateResult => {
  if (state === "missing") {
    return `decide_prior_work named ${known}, which Linear no longer finds.${also}`;
  }
  if (state === "closed") {
    return `Same outcome as ${known}, which is closed with no open master above it: check whether this is a regression.${also}`;
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

/** A refusal for a report already a duplicate, or one whose searches have not both run. */
const uncheckedRefusal = (
  issue: string,
  check: KnownIssueCheck | undefined,
  ownState: string
): string | null => {
  if (ownState === "duplicate") {
    return `${issue} is already a duplicate of a known issue, so Fixy works that issue and no new run starts for this report. Do not hand it to Fixy.`;
  }
  const missing = (["masters", "duplicates"] as const).filter(
    (scope) => !(check && scope in check.searches)
  );
  return missing.length > 0
    ? `Before a widget bug goes to Fixy, check it against open known issues: call find_related_issues with issue ${issue} and scope ${missing.join(" and ")}, then decide_prior_work with issue ${issue} and the hits. Nothing was written.`
    : null;
};

/**
 * Whether a widget engineering handoff may start Fixy. It refuses a report
 * already in a duplicate state; until both searches ran for this ticket and,
 * when they found anything, decide_prior_work judged some of the hits; and
 * while a known issue is open and no Duplicate join was tried. Every
 * uncertain outcome passes with a note naming the candidates, so Fixy can
 * join one once it has looked.
 */
export const knownIssueGate = (
  issue: string,
  check: KnownIssueCheck | undefined,
  ownState: string,
  knownIssueState: KnownIssueState | null
): GateResult => {
  const unchecked = uncheckedRefusal(issue, check, ownState);
  if (unchecked || !check) {
    return refuse(unchecked ?? "");
  }
  const { searches } = check;
  const self = key(issue);
  const hits = [
    ...new Set([...(searches.masters ?? []), ...(searches.duplicates ?? [])]),
  ].filter((hit) => hit !== self);
  const notes = Object.values(searches).includes(null)
    ? ["A known-issue search failed, so the report may match an open issue."]
    : [];
  if (hits.length === 0) {
    return { notes };
  }
  const judged = Object.keys(check.judged).length > 0;
  if (!(judged || check.undecided)) {
    return refuse(
      `The known-issue searches found ${hits.length} candidate${hits.length === 1 ? "" : "s"}. Call decide_prior_work with issue ${issue}, the report and those hits (at most 8 a call) before handing it to Fixy. Nothing was written.`
    );
  }
  const [known] = check.knownIssues;
  const uncertain = Object.entries(check.judged)
    .filter(([id, match]) => id !== known && match === "partial_or_adjacent")
    .slice(0, NOTE_CANDIDATES)
    .map(([id, match]) => `${id} (${MATCH_WORDS[match]})`)
    .join(", ");
  if (known && knownIssueState) {
    const also = uncertain ? ` Also related: ${uncertain}.` : "";
    const line = knownIssueLine(known, knownIssueState, check.join, also);
    return typeof line === "string" ? { notes: [...notes, line] } : line;
  }
  if (check.undecided) {
    const unjudged = hits.filter((hit) => !(hit in check.judged));
    notes.push(
      `Known-issue check partly undecided; unjudged matches: ${unjudged.slice(0, NOTE_CANDIDATES).join(", ") || "none"}.`
    );
  }
  return uncertain
    ? { notes: [...notes, `Possible known issue: ${uncertain}.`] }
    : { notes };
};

/** The ticket as hand_to_fixy reads it. */
export interface HandoffTicket {
  attachments: readonly { title: string; url: string }[];
  description: string | null;
  identifier: string;
  state: { type: string };
}

// Linear gives Duplicate its own terminal state type, apart from canceled.
const CLOSED_TYPES = new Set(["canceled", "completed", "duplicate"]);

/** Reads the known issue's state and up to three parents' states, its own first; null when Linear has no such issue. A failed read throws. */
export type ReadChain = (identifier: string) => Promise<string[] | null>;

/**
 * The known-issue gate (ENG-21101) for an eng handoff of a widget ticket not
 * yet handed off. A failed read of the known issue refuses, since the
 * handoff can't tell whether it would start a second run.
 */
export const widgetBugGate = async (
  lanes: readonly string[],
  ticket: HandoffTicket,
  alreadyHandedOff: boolean,
  checks: () => Record<string, KnownIssueCheck>,
  readChain: ReadChain
): Promise<GateResult> => {
  if (alreadyHandedOff || !lanes.includes("eng") || !isWidgetTicket(ticket)) {
    return { notes: [] };
  }
  const check = checkFor(checks(), ticket.identifier);
  const known = check?.knownIssues[0];
  let state: KnownIssueState | null = null;
  if (known) {
    const chain = await readChain(known).catch(() => undefined);
    if (chain === undefined) {
      return refuse(
        `Could not read ${known}'s state, so the handoff was not written. Call hand_to_fixy again.`
      );
    }
    if (chain === null) {
      state = "missing";
    } else {
      state = chain.some((type) => !CLOSED_TYPES.has(type)) ? "open" : "closed";
    }
  }
  return knownIssueGate(ticket.identifier, check, ticket.state.type, state);
};
