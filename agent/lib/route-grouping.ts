import type { IssueNode, IssuesData } from "./linear-api.js";
import {
  APPROVED_LABEL,
  BUG_LABEL,
  DECLINED_LABEL,
  FALLBACK_OWNER,
  FEATURE_REQUEST_LABEL,
  NEEDS_APPROVAL_LABEL,
  NEEDS_GROUPING_LABEL,
  SUPPORT_OWNER,
} from "./owner-map.js";

/** Where a repeat with no open master waits for the grouping sweep. */
const DEFERRED_STATE = "Backlog";

import {
  type Gql,
  keptLabels,
  named,
  type RouteIssue,
  type RouteTicketInput,
  type RouteTicketResult,
  requireIssue,
} from "./route-ticket-shared.js";

/** Where a matched report goes, and what a route_ticket call may close, settled before any write. */

/**
 * What marks a master (ENG-16608): engineering-handoff writes every master
 * from its template, whose Regression seam section no customer report has; a
 * master made by hand is known by already parenting an issue. Labels cannot
 * mark one: masters carry no marker label, and a report on the unproven
 * branch keeps no labels either, so having none proves nothing.
 */
export const MASTER_MARKER = "## Regression seam";

/** The ticket's label names, lower-cased, once this call's label changes land: the kept labels the write saves, then the ones it adds. */
export const finalLabels = (
  issue: RouteIssue,
  input: RouteTicketInput
): Set<string> =>
  new Set(
    [
      ...keptLabels(issue, input).map((label) => label.name),
      ...(input.addLabels ?? []),
    ].map((name) => name.toLowerCase())
  );

/**
 * Whether a person declined this request: the Declined label is already on
 * the ticket as read from Linear before this call. A label this call would
 * add never counts, and `refuseSelfDecline` refuses one.
 */
const declinedByPerson = (issue: RouteIssue): boolean =>
  issue.labels.nodes.some(
    (label) => label.name.toLowerCase() === DECLINED_LABEL.toLowerCase()
  );

/** Only a person, or the approval flow's decision, writes Declined; Foreman never declines a request itself. */
function refuseSelfDecline(input: RouteTicketInput): void {
  if (
    (input.addLabels ?? []).some(
      (name) => name.trim().toLowerCase() === DECLINED_LABEL.toLowerCase()
    )
  ) {
    throw new Error(
      `Only a person adds ${DECLINED_LABEL}, so nothing was written. Leave the request in Backlog with ${NEEDS_APPROVAL_LABEL} for ${FALLBACK_OWNER} to decide.`
    );
  }
}

/** Whether the ticket carries the Bug label once this call's label changes land. */
export const carriesBug = (
  issue: RouteIssue,
  input: RouteTicketInput
): boolean => finalLabels(issue, input).has(BUG_LABEL.toLowerCase());

/**
 * An unapproved feature request never closes unless a person declined it
 * (ENG-15932): the decision code parks it in Backlog, and this refuses a
 * fallback or hand-written route that would close it anyway.
 */
export function refuseUnapprovedClose(
  issue: RouteIssue,
  input: RouteTicketInput
): void {
  const labels = finalLabels(issue, input);
  if (
    named(input.state, "canceled", "done", "duplicate") &&
    labels.has(FEATURE_REQUEST_LABEL.toLowerCase()) &&
    !labels.has(APPROVED_LABEL.toLowerCase()) &&
    !declinedByPerson(issue)
  ) {
    throw new Error(
      `${issue.identifier} would be ${input.state}, but an unapproved Feature Request never closes unless a person declined it, so nothing was written. Route it to Backlog with ${NEEDS_APPROVAL_LABEL} and ${FALLBACK_OWNER}, using relatedTo for its match.`
    );
  }
}

export interface DuplicateRouting {
  /** The master search cutoff for this session (`masterCreatedAfter`). */
  mastersCreatedAfter?: string | null;
}

/** One RelatedIssues read, the master search's own query, for at most one issue. */
export async function relatedOne(
  gql: Gql,
  filter: Record<string, unknown>
): Promise<IssueNode | undefined> {
  const { issues } = await gql<IssuesData>("RelatedIssues", {
    after: null,
    filter,
    first: 1,
    includeArchived: true,
  });
  return issues.nodes[0];
}

const CLOSED_STATE_TYPES = new Set(["canceled", "completed"]);

interface MasterFacts {
  createdAt: string;
  open: boolean;
}

/**
 * The master's creation time and whether it is still open, or null when the
 * issue is no master. A master carries the master marker (engineering-handoff
 * writes it), or was made by hand and already parents an issue, as reused
 * masters do; a lone report has neither.
 */
export async function masterFacts(
  gql: Gql,
  identifier: string,
  id: string
): Promise<MasterFacts | null> {
  const marked = await relatedOne(gql, {
    description: { contains: MASTER_MARKER },
    id: { eq: id },
  });
  const child = marked
    ? undefined
    : await relatedOne(gql, { parent: { id: { eq: id } } });
  if (!(marked || child)) {
    return null;
  }
  const node = marked ?? (await relatedOne(gql, { id: { eq: id } }));
  if (!node) {
    throw new Error(
      `Could not read when ${identifier} was created, so nothing was written.`
    );
  }
  return {
    createdAt: node.createdAt,
    open: !CLOSED_STATE_TYPES.has(node.state.type),
  };
}

/**
 * The match itself when it is an open master, else its parent when that is
 * one. A closed master that engineering-handoff moved under a new open master
 * hands its reports to that parent; with none, the closed master is returned
 * so the caller can say why nothing took the report.
 */
async function masterOf(
  gql: Gql,
  match: RouteIssue
): Promise<(MasterFacts & { identifier: string }) | null> {
  const own = await masterFacts(gql, match.identifier, match.id);
  if (own?.open) {
    return { ...own, identifier: match.identifier };
  }
  const parent = match.parent?.identifier;
  const facts = parent
    ? await masterFacts(gql, parent, (await requireIssue(gql, parent)).id)
    : null;
  if (parent && facts && (facts.open || own === null)) {
    return { ...facts, identifier: parent };
  }
  return own === null ? null : { ...own, identifier: match.identifier };
}

export const beforeCutoff = (createdAt: string, cutoff: string | null) =>
  cutoff !== null && Date.parse(createdAt) < Date.parse(cutoff);

/**
 * The exact retry for a master past the cutoff: a new master, the match moved
 * under it, then this call again with the new master as parent and owner
 * source, which also holds when the match is itself the stale master.
 */
const staleMaster = (
  identifier: string,
  cutoff: string | null,
  match: string,
  refused = true
) =>
  new Error(
    `${identifier} was created before ${cutoff}, so it cannot take new reports${refused ? " and nothing was written" : ""}. Create a new master through engineering-handoff from this investigation (aggregate evidence only: no organization id, email or customer rows), relate ${identifier} for history, call route_ticket with issue ${match} and parent set to the new master, then call this again with duplicateOf ${match}, parent the new master and inheritAssigneeFrom the new master.`
  );

/**
 * A parent passed in for a match with no eligible master: an open master the
 * match is already under, inside the session's cutoff, so both reports join
 * it and neither is left detached.
 */
async function checkedParent(
  gql: Gql,
  match: RouteIssue,
  parent: string,
  cutoff: string | null
): Promise<string> {
  const { id } = await requireIssue(gql, parent);
  const facts = await masterFacts(gql, parent, id);
  if (facts === null) {
    throw new Error(
      `${parent} is not a master, so nothing was written. Pass the master as parent, or create one through engineering-handoff first.`
    );
  }
  if (match.parent?.identifier !== parent) {
    throw new Error(
      `${match.identifier} is not under ${parent}, so nothing was written. Call route_ticket with issue ${match.identifier} and parent ${parent} first, so both reports join that master, then call this again.`
    );
  }
  if (beforeCutoff(facts.createdAt, cutoff)) {
    throw staleMaster(parent, cutoff, match.identifier);
  }
  if (!facts.open) {
    throw new Error(
      `${parent} is closed, so it cannot take new reports and nothing was written.`
    );
  }
  return parent;
}

type Grouping = { parent: string } | { reason: string };

/**
 * Where a matched report goes (ENG-16608, ENG-17138): under the match when it
 * is an open master, else under the match's parent when that is one. A master
 * created before the session's master-search cutoff, or one already closed,
 * is not eligible. With no eligible master, the report is not closed: it is
 * related to the match and labelled for the grouping sweep, whatever its
 * classification, so a repeat is never closed on a lone or closed ticket.
 */
async function groupingOf(
  gql: Gql,
  match: RouteIssue,
  input: RouteTicketInput,
  cutoff: string | null
): Promise<Grouping> {
  const master = await masterOf(gql, match);
  const stale = master ? beforeCutoff(master.createdAt, cutoff) : false;
  if (master && !stale && master.open) {
    if (input.parent !== undefined && input.parent !== master.identifier) {
      throw new Error(
        `${match.identifier} belongs under its master ${master.identifier}, not ${input.parent}, so nothing was written. Drop parent or pass ${master.identifier}.`
      );
    }
    return { parent: master.identifier };
  }
  if (input.parent !== undefined) {
    return { parent: await checkedParent(gql, match, input.parent, cutoff) };
  }
  if (master && stale) {
    return {
      reason: staleMaster(master.identifier, cutoff, match.identifier, false)
        .message,
    };
  }
  return {
    reason: master
      ? `its master ${master.identifier} is already closed`
      : `${match.identifier} is not a master and is not under one`,
  };
}

/** Without a match, Duplicate needs an open master passed as parent, as on a retry after the relation landed. */
async function requireOpenMasterParent(
  gql: Gql,
  parent: string | undefined
): Promise<void> {
  const facts = parent
    ? await masterFacts(gql, parent, (await requireIssue(gql, parent)).id)
    : null;
  if (!facts?.open) {
    throw new Error(
      "A ticket moves to Duplicate only under an open master, so nothing was written. Pass duplicateOf with the match, or parent with the open master it already joined."
    );
  }
}

/** What the matched report does: close under its master, stay open beside it, or wait for grouping. */
export interface MatchPlan {
  /** The master the report joins, when there is an eligible one. */
  parent?: string;
  /** Why no master took it; the report stays open with the grouping label. */
  unjoined?: string;
}

const TRAILING_STOP = /\.$/u;

const groupingWarning = (
  issue: RouteIssue,
  match: string,
  why: string,
  bug: boolean
) =>
  `${issue.identifier} stays open because ${why.replace(TRAILING_STOP, "")}. It is related to ${match}, labelled ${NEEDS_GROUPING_LABEL}, and a closing state became Backlog, so the grouping sweep puts it under a master.${
    bug
      ? ` To close it now as a Bug duplicate, create the master through engineering-handoff (aggregate evidence only), call route_ticket with issue ${match} and parent set to the new master, then call this again.`
      : ""
  }`;

/** The route a call resolves to before any write: the match, its master, and what it may close. */
export interface RoutePlan {
  closes: boolean;
  keepsState: boolean;
  match: RouteIssue | null;
  owned: RouteTicketInput;
  parent: string | undefined;
  plan: MatchPlan;
  warnings: string[];
}

function refuseMatchMisuse(input: RouteTicketInput): void {
  if (input.duplicateOf !== undefined && input.relatedTo !== undefined) {
    throw new Error(
      "Pass duplicateOf to close on a match or relatedTo to stay open beside it, not both. Nothing was written."
    );
  }
  if (input.relatedTo !== undefined && named(input.state, "duplicate")) {
    throw new Error(
      "relatedTo keeps the report open, so it cannot move to Duplicate. Nothing was written."
    );
  }
}

async function matchPlanOf(
  gql: Gql,
  match: RouteIssue | null,
  input: RouteTicketInput,
  opts: DuplicateRouting
): Promise<MatchPlan> {
  if (!match) {
    if (named(input.state, "duplicate")) {
      await requireOpenMasterParent(gql, input.parent);
    }
    return {};
  }
  const grouping = await groupingOf(
    gql,
    match,
    input,
    opts.mastersCreatedAfter ?? null
  );
  return "parent" in grouping
    ? { parent: grouping.parent }
    : { unjoined: grouping.reason };
}

/** Resolves the match and its master and settles what this call may close, before any write. */
export async function planRoute(
  gql: Gql,
  issue: RouteIssue,
  input: RouteTicketInput,
  opts: DuplicateRouting
): Promise<RoutePlan> {
  refuseMatchMisuse(input);
  refuseSelfDecline(input);
  refuseUnapprovedClose(issue, input);
  // Resolve the match before the first write, so a bad identifier fails the
  // whole call rather than leaving a routed ticket with no relation.
  const matchId = input.duplicateOf ?? input.relatedTo;
  const match = matchId === undefined ? null : await requireIssue(gql, matchId);
  const plan = await matchPlanOf(gql, match, input, opts);
  const warnings: string[] = [];
  if (match && plan.unjoined !== undefined) {
    warnings.push(
      groupingWarning(
        issue,
        match.identifier,
        plan.unjoined,
        carriesBug(issue, input)
      )
    );
  }
  // A closing route with no open master is deferred to the grouping sweep: it
  // leaves Triage for Backlog with a person who sees it, not the match's owner.
  // A person's Declined decision keeps its Canceled state: it is only related
  // and labelled for grouping, never reopened.
  const deferred =
    plan.unjoined !== undefined &&
    named(input.state, "canceled", "done", "duplicate") &&
    !declinedByPerson(issue);
  const keepsState = !deferred;
  const parent = match ? plan.parent : input.parent;
  // A matched report takes its owner from the master it is parented under,
  // so the report and its master keep one owner even when the match is held
  // by someone else; the area owner stays the fallback.
  const inherit =
    match && parent !== undefined && input.inheritAssigneeFrom !== undefined;
  return {
    // A duplicate relation only for a report that joins its master; every
    // other match is related, so it never closes the report.
    closes: input.duplicateOf !== undefined && plan.parent !== undefined,
    keepsState,
    match,
    owned: {
      ...input,
      ...(plan.unjoined === undefined
        ? {}
        : { addLabels: [...(input.addLabels ?? []), NEEDS_GROUPING_LABEL] }),
      ...(inherit ? { inheritAssigneeFrom: parent } : {}),
      state: keepsState ? input.state : undefined,
      ...(deferred
        ? {
            assignee: finalLabels(issue, input).has(
              FEATURE_REQUEST_LABEL.toLowerCase()
            )
              ? FALLBACK_OWNER
              : SUPPORT_OWNER,
            inheritAssigneeFrom: undefined,
            state: DEFERRED_STATE,
          }
        : {}),
    },
    parent,
    plan,
    warnings,
  };
}

export const groupingOutcome = (
  routed: RoutePlan
): RouteTicketResult["grouping"] => {
  if (!routed.match) {
    return null;
  }
  return routed.plan.parent ? "joined" : "needs-grouping";
};
