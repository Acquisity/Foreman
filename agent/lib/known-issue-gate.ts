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
export interface JoinAttempt {
  error?: string;
  grouping: "joined" | "needs-grouping" | null;
}

export interface KnownIssueCheck {
  /** Each route_ticket call that asked for Duplicate under a match, by the match: its error when it was refused, and its grouping. */
  joins?: Record<string, JoinAttempt>;
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

/** Records one find_related_issues scope for the issue: the identifiers it found, or null when it failed. */
export const recordSearch = (
  issue: string,
  scope: "duplicates" | "masters",
  hits: readonly string[] | null
) =>
  recordKnownIssueCheck(issue, (check) => {
    // A narrowed search adds to what an earlier one found, and a failure after a success keeps it, so a refined
    // search never drops a match already judged.
    const before = check.searches[scope];
    const found = hits?.map((hit) => hit.toUpperCase());
    const merged =
      found && before ? [...new Set([...before, ...found])] : (found ?? before);
    return {
      ...check,
      searches: { ...check.searches, [scope]: merged ?? null },
    };
  });

/** Adds one decide_prior_work batch to the judgments already recorded. */
export const withDecision = (
  check: KnownIssueCheck,
  decision: PriorWorkDecision | null
): KnownIssueCheck => {
  if (!decision) {
    return { ...check, undecided: true };
  }
  // Jev names one known issue a batch; every same-outcome candidate counts, so a closed one named never hides an open one.
  const named = [
    ...(decision.outcome === "known_issue" && decision.knownIssue
      ? [decision.knownIssue]
      : []),
    ...decision.candidates
      .filter((c) => c.match === "same_outcome")
      .map((c) => c.identifier),
  ].map((id) => id.toUpperCase());
  return {
    ...check,
    judged: {
      ...check.judged,
      ...Object.fromEntries(
        decision.candidates.map((c) => [c.identifier.toUpperCase(), c.match])
      ),
    },
    knownIssues: [...new Set([...check.knownIssues, ...named])],
  };
};

export const isDuplicateState = (state: string | undefined) =>
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
    joins: {
      ...check.joins,
      [target]: {
        error: result.error,
        grouping:
          result.grouping === "joined" || result.grouping === "needs-grouping"
            ? result.grouping
            : null,
      },
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

/** The note for the known issue the handoff goes ahead beside. */
const knownIssueLine = (
  known: string,
  state: KnownIssueState,
  join: JoinAttempt | undefined,
  also: string
): string => {
  if (state === "missing") {
    return `decide_prior_work named ${known}, which Linear no longer finds.${also}`;
  }
  if (state === "closed") {
    return `Same outcome as ${known}, which is closed with no open master above it: check whether this is a regression.${also}`;
  }
  const why = join?.error
    ? "route_ticket refused the join"
    : "it has no open master to join";
  return `Same outcome as open ${known}, but ${why}: join it there if your look agrees.${also}`;
};

/** A refusal for a report already a duplicate, or one whose searches have not both run, or both failed. */
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
  if (check?.searches.masters === null && check.searches.duplicates === null) {
    return `Both known-issue searches failed, so ${issue} was not checked against open known issues. Call find_related_issues again for both scopes. Nothing was written.`;
  }
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
  knownIssueStates: Record<string, KnownIssueState>
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
  // A failed batch (Jev down) never blocks the customer; judgments of issues the searches never found don't count.
  if (!(hits.some((hit) => hit in check.judged) || check.undecided)) {
    return refuse(
      `The known-issue searches found ${hits.length} candidate${hits.length === 1 ? "" : "s"}. Call decide_prior_work with issue ${issue}, the report and those hits (at most 8 a call) before handing it to Fixy. Nothing was written.`
    );
  }
  // Every open known issue needs its Duplicate join tried; an open one wins over a closed one named first.
  const open = check.knownIssues.filter(
    (id) => knownIssueStates[id] === "open"
  );
  const untried = open.find((id) => !check.joins?.[id]);
  if (untried) {
    return refuse(
      `decide_prior_work found ${untried}, an open known issue with the same outcome. Join it with route_ticket (state Duplicate, duplicateOf and inheritAssigneeFrom ${untried}) instead of starting a new Fixy run. Hand it to Fixy only if that join is refused. Nothing was written.`
    );
  }
  const known = open[0] ?? check.knownIssues[0];
  const knownState = known ? knownIssueStates[known] : undefined;
  const uncertain = Object.entries(check.judged)
    .filter(
      ([id, match]) =>
        !check.knownIssues.includes(id) && match === "partial_or_adjacent"
    )
    .slice(0, NOTE_CANDIDATES)
    .map(([id, match]) => `${id} (${MATCH_WORDS[match]})`)
    .join(", ");
  if (known && knownState) {
    const also = uncertain ? ` Also related: ${uncertain}.` : "";
    const line = knownIssueLine(known, knownState, check.joins?.[known], also);
    return { notes: [...notes, line, ...uncertainLines(check, hits, "")] };
  }
  return { notes: [...notes, ...uncertainLines(check, hits, uncertain)] };
};

/** Unjudged hits after a failed batch, then the partial matches when no known-issue line names them. */
const uncertainLines = (
  check: KnownIssueCheck,
  hits: string[],
  uncertain: string
): string[] => {
  // A failed batch a later one retried leaves nothing unjudged, so it adds no note.
  const unjudged = check.undecided
    ? hits.filter((hit) => !(hit in check.judged))
    : [];
  return [
    ...(unjudged.length > 0
      ? [
          `Known-issue check partly undecided; unjudged matches: ${unjudged.slice(0, NOTE_CANDIDATES).join(", ")}.`,
        ]
      : []),
    ...(uncertain ? [`Possible known issue: ${uncertain}.`] : []),
  ];
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

const stateOf = (chain: string[] | null): KnownIssueState => {
  if (chain === null) {
    return "missing";
  }
  return chain.some((type) => !CLOSED_TYPES.has(type)) ? "open" : "closed";
};

/**
 * The known-issue gate (ENG-21101) for an eng handoff of a widget ticket not
 * yet handed off. It reads every known issue a decision named; a failed read
 * refuses, since the handoff can't tell whether it would start a second run.
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
  const known = check?.knownIssues ?? [];
  const chains = await Promise.all(
    known.map((id) => readChain(id).catch(() => undefined))
  );
  const unread = known.filter((_, index) => chains[index] === undefined);
  if (unread.length > 0) {
    return refuse(
      `Could not read ${unread.join(", ")}'s state, so the handoff was not written. Call hand_to_fixy again.`
    );
  }
  const states = Object.fromEntries(
    known.map((id, index) => [id, stateOf(chains[index] ?? null)])
  );
  return knownIssueGate(ticket.identifier, check, ticket.state.type, states);
};
