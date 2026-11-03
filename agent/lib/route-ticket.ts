import { type LinearGraphqlOptions, linearGraphql } from "./linear-api.js";
import {
  APPROVED_LABEL,
  BUG_LABEL,
  FALLBACK_OWNER,
  FEATURE_REQUEST_LABEL,
  mappedOwner,
  mayHoldTicket,
  NEEDS_APPROVAL_LABEL,
  ownerNames,
} from "./owner-map.js";
import {
  type DuplicateRouting,
  groupingOutcome,
  planRoute,
} from "./route-grouping.js";
import {
  exactlyOne,
  type Gql,
  keptLabels,
  type Named,
  named,
  type RouteIssue,
  type RouteTicketInput,
  type RouteTicketResult,
  reason,
  requireIssue,
} from "./route-ticket-shared.js";

const MAX_LABEL_PAGES = 8;

interface LabelPage {
  nodes: Named[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
}

interface Outcome {
  duplicateOf: string | null;
  grouping: RouteTicketResult["grouping"];
}

const toResult = (
  issue: RouteIssue,
  warnings: string[],
  outcome: Outcome
): RouteTicketResult => ({
  assignee: issue.assignee?.name ?? null,
  ...outcome,
  identifier: issue.identifier,
  labels: issue.labels.nodes.map((label) => label.name),
  parentIdentifier: issue.parent?.identifier ?? null,
  priority: issue.priority,
  projectId: issue.project?.id ?? null,
  projectName: issue.project?.name ?? null,
  state: issue.state.name,
  url: issue.url,
  warnings,
});

interface FinalLabels {
  changed: boolean;
  ids: string[];
  names: string[];
}

async function teamLabelsNamed(
  gql: Gql,
  issue: RouteIssue,
  names: string[]
): Promise<Named[]> {
  const labels: Named[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_LABEL_PAGES; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: label pages are sequential cursors.
    const { issueLabels }: { issueLabels: LabelPage } = await gql<{
      issueLabels: LabelPage;
    }>("TeamLabels", { after, teamId: issue.team.id });
    labels.push(...issueLabels.nodes);
    after = issueLabels.pageInfo.hasNextPage
      ? issueLabels.pageInfo.endCursor
      : null;
    if (!after) {
      break;
    }
  }
  const byName = new Map(
    labels.map((label) => [label.name.toLowerCase(), label])
  );
  const unknown = names.filter((name) => !byName.has(name.toLowerCase()));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown label${unknown.length > 1 ? "s" : ""} ${unknown.map((name) => `"${name}"`).join(", ")}. Valid labels: ${labels
        .map((label) => label.name)
        .sort((a, b) => a.localeCompare(b))
        .join(", ")}.`
    );
  }
  return names.flatMap((name) => byName.get(name.toLowerCase()) ?? []);
}

/** The ticket's labels after the call: its current labels minus the ones to remove, then the ones to add; unknown names throw before any write. */
async function resolveLabels(
  gql: Gql,
  issue: RouteIssue,
  input: RouteTicketInput
): Promise<FinalLabels> {
  const kept = keptLabels(issue, input);
  const added = input.addLabels?.length
    ? await teamLabelsNamed(gql, issue, input.addLabels)
    : [];
  const final = [
    ...new Map(
      [...kept, ...added].map((label) => [label.id, label] as const)
    ).values(),
  ];
  return {
    changed: added.length > 0 || kept.length < issue.labels.nodes.length,
    ids: final.map((label) => label.id),
    names: final.map((label) => label.name),
  };
}

async function chooseAssignee(
  gql: Gql,
  input: RouteTicketInput,
  labels: string[]
): Promise<{ id?: string; warnings: string[] }> {
  const warnings: string[] = [];
  if (input.inheritAssigneeFrom !== undefined) {
    const source = await requireIssue(gql, input.inheritAssigneeFrom);
    const holder = source.assignee ? mappedOwner(source.assignee.name) : null;
    if (source.assignee && holder && mayHoldTicket(holder, labels)) {
      return { id: source.assignee.id, warnings };
    }
    if (source.assignee && !holder) {
      warnings.push(
        `${input.inheritAssigneeFrom} is held by ${source.assignee.name}, who is not in the owner map, so the assignee was not inherited.`
      );
    } else if (source.assignee) {
      warnings.push(
        `${input.inheritAssigneeFrom} is held by ${source.assignee.name}, a developer, and this ticket is neither a ${BUG_LABEL}, an approved ${FEATURE_REQUEST_LABEL} nor one waiting for approval, so the assignee was not inherited.`
      );
    }
  }
  if (input.assignee === undefined) {
    return { warnings };
  }
  const owner = mappedOwner(input.assignee);
  if (!owner) {
    throw new Error(
      `"${input.assignee}" is not in the owner map, so nothing was assigned. Use one of: ${ownerNames().join(", ")}.`
    );
  }
  if (!mayHoldTicket(owner, labels)) {
    throw new Error(
      `${owner.name} is a developer. A ticket goes to a developer only when it is labelled ${BUG_LABEL}, or ${FEATURE_REQUEST_LABEL} and ${APPROVED_LABEL}; only ${FALLBACK_OWNER} may hold a ${FEATURE_REQUEST_LABEL} marked ${NEEDS_APPROVAL_LABEL}. Add the label or leave the assignee unchanged.`
    );
  }
  const { users } = await gql<{ users: { nodes: Named[] } }>("Users", {
    name: owner.name,
  });
  return { id: exactlyOne("user", owner.name, users.nodes), warnings };
}

async function resolveAssigneeId(
  gql: Gql,
  issue: RouteIssue,
  input: RouteTicketInput,
  labels: FinalLabels
): Promise<{ id?: string | null; warnings: string[] }> {
  const chosen = await chooseAssignee(gql, input, labels.names);
  if (chosen.id !== undefined) {
    return chosen;
  }
  const holder = issue.assignee ? mappedOwner(issue.assignee.name) : null;
  if (
    input.releaseDeveloper &&
    holder?.lane === "developer" &&
    holder.name !== FALLBACK_OWNER
  ) {
    return { id: null, warnings: chosen.warnings };
  }
  if (labels.changed && holder && !mayHoldTicket(holder, labels.names)) {
    throw new Error(
      `${issue.identifier} is held by ${holder.name}, a developer, and this label change would leave it labelled ${labels.names.length > 0 ? labels.names.join(", ") : "nothing"}, so nothing was written. A developer holds a ticket only when it is labelled ${BUG_LABEL}, or ${FEATURE_REQUEST_LABEL} and ${APPROVED_LABEL}; only ${FALLBACK_OWNER} may hold a ${FEATURE_REQUEST_LABEL} marked ${NEEDS_APPROVAL_LABEL}. Keep the label, assign someone who may hold it, or pass releaseDeveloper.`
    );
  }
  return chosen;
}

/**
 * The parent, however it was chosen, refused when someone outside the owner
 * map holds it, so a report and its master keep one owner.
 */
async function requireOwnedParent(
  gql: Gql,
  identifier: string
): Promise<RouteIssue> {
  const parent = await requireIssue(gql, identifier);
  if (parent.assignee && !mappedOwner(parent.assignee.name)) {
    throw new Error(
      `${identifier} is held by ${parent.assignee.name}, who is not in the owner map, so nothing was written. Move that master to its area owner first, so the report and its master keep one owner.`
    );
  }
  return parent;
}

/** Builds the single issueUpdate input from the decisions given. */
async function buildUpdate(
  gql: Gql,
  issue: RouteIssue,
  input: RouteTicketInput,
  parent: string | undefined
): Promise<{ update: Record<string, unknown>; warnings: string[] }> {
  const update: Record<string, unknown> = {};
  const labels = await resolveLabels(gql, issue, input);
  if (labels.changed) {
    update.labelIds = labels.ids;
  }
  if (input.state !== undefined) {
    const { workflowStates } = await gql<{
      workflowStates: { nodes: Named[] };
    }>("WorkflowStates", { name: input.state, teamId: issue.team.id });
    update.stateId = exactlyOne("state", input.state, workflowStates.nodes);
  }
  if (input.priority !== undefined) {
    update.priority = input.priority;
  }
  if (input.project !== undefined) {
    const { projects } = await gql<{ projects: { nodes: Named[] } }>(
      "Projects",
      { name: input.project, teamId: issue.team.id }
    );
    update.projectId = exactlyOne(
      "project on the ticket's team",
      input.project,
      projects.nodes
    );
  }
  if (parent !== undefined) {
    update.parentId = (await requireOwnedParent(gql, parent)).id;
  }
  const assignee = await resolveAssigneeId(gql, issue, input, labels);
  if (assignee.id !== undefined) {
    update.assigneeId = assignee.id;
  }
  return { update, warnings: assignee.warnings };
}

/** The match's relation, written before the update; a failure writes nothing. */
async function writeMatchRelation(
  gql: Gql,
  issue: RouteIssue,
  match: RouteIssue,
  type: "duplicate" | "related",
  signal?: AbortSignal
): Promise<string> {
  try {
    const { issueRelationCreate } = await gql<{
      issueRelationCreate: { success: boolean };
    }>("RouteRelation", {
      input: { issueId: issue.id, relatedIssueId: match.id, type },
    });
    if (!issueRelationCreate.success) {
      throw new Error("Linear did not confirm the relation.");
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw new Error(
      `Nothing was written: the ${type} relation to ${match.identifier} was not recorded (${reason(error)}).`,
      { cause: error }
    );
  }
  return match.identifier;
}

/** The one issueUpdate; after a recorded relation, a failure says how to finish. */
async function writeUpdate(
  gql: Gql,
  issue: RouteIssue,
  update: Record<string, unknown>,
  after: {
    duplicateOf: string | null;
    parent?: string;
    /** The input field that named the match, so the retry keeps it. */
    matchField: "duplicateOf" | "relatedTo";
    relation: "duplicate" | "related";
    signal?: AbortSignal;
  }
): Promise<void> {
  try {
    const { issueUpdate } = await gql<{ issueUpdate: { success: boolean } }>(
      "RouteIssueUpdate",
      { id: issue.id, input: update }
    );
    if (!issueUpdate.success) {
      throw new Error("Linear did not confirm the issue update.");
    }
  } catch (error) {
    if (after.duplicateOf === null || after.signal?.aborted) {
      throw error;
    }
    // A related link is not the duplicate relation Linear needs before
    // Duplicate, so its retry keeps duplicateOf; a duplicate relation's does not.
    throw new Error(
      after.relation === "related"
        ? `Only a related link to ${after.duplicateOf} was recorded, but the update failed (${reason(error)}). Call route_ticket again with the same input, ${after.matchField} ${after.duplicateOf} included, to apply the rest.`
        : `The duplicate relation to ${after.duplicateOf} was recorded, but the update failed (${reason(error)}). Call route_ticket again without duplicateOf${after.parent ? `, with parent ${after.parent} and inheritAssigneeFrom ${after.parent}` : ""}, to apply the rest.`,
      { cause: error }
    );
  }
}

/** Attaches each link; a failed one is a warning, and the result says whether any landed. */
async function writeLinks(
  gql: Gql,
  issue: RouteIssue,
  links: RouteTicketInput["links"],
  warn: (error: unknown, message: string) => void
): Promise<boolean> {
  let wrote = false;
  for (const link of links ?? []) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: attachments are written one at a time so a failure names the link.
      const { attachmentLinkURL } = await gql<{
        attachmentLinkURL: { success: boolean };
      }>("RouteAttachment", {
        issueId: issue.id,
        title: link.title,
        url: link.url,
      });
      if (!attachmentLinkURL.success) {
        throw new Error("Linear did not confirm the attachment.");
      }
      wrote = true;
    } catch (error) {
      warn(error, `Link ${link.url} was not attached`);
    }
  }
  return wrote;
}

/**
 * The read-back. A Duplicate is a success only once it shows the report under
 * its master; any other read-back failure is a warning on a routed ticket,
 * reported with the fields from before routing.
 */
async function readBackRouted(
  gql: Gql,
  input: RouteTicketInput,
  prior: RouteIssue,
  confirmsParent: string | undefined,
  warn: (error: unknown, message: string) => void,
  signal?: AbortSignal
): Promise<RouteIssue | null> {
  let after: RouteIssue | null = null;
  try {
    after = await requireIssue(gql, input.issue);
  } catch (error) {
    if (confirmsParent === undefined) {
      warn(
        error,
        "The ticket was updated but could not be read back, so the fields below are from before routing"
      );
    } else if (signal?.aborted) {
      throw error;
    }
  }
  if (
    confirmsParent !== undefined &&
    after?.parent?.identifier !== confirmsParent
  ) {
    await restoreState(gql, prior, input.issue, confirmsParent);
  }
  return after;
}

/**
 * A Duplicate whose parent the read-back cannot confirm must not stay
 * closed: the report goes back to its state from before the call, through
 * the same update, and the call fails with the retry to make.
 */
async function restoreState(
  gql: Gql,
  prior: RouteIssue,
  identifier: string,
  master: string
): Promise<never> {
  const retry = `Call route_ticket again with parent ${master} and state Duplicate.`;
  try {
    const { workflowStates } = await gql<{
      workflowStates: { nodes: Named[] };
    }>("WorkflowStates", { name: prior.state.name, teamId: prior.team.id });
    const { issueUpdate } = await gql<{ issueUpdate: { success: boolean } }>(
      "RouteIssueUpdate",
      {
        id: prior.id,
        input: {
          stateId: exactlyOne("state", prior.state.name, workflowStates.nodes),
        },
      }
    );
    if (!issueUpdate.success) {
      throw new Error("Linear did not confirm the issue update.");
    }
  } catch (error) {
    throw new Error(
      `${identifier} was written but could not be confirmed under ${master}, and moving it back to ${prior.state.name} failed (${reason(error)}), so it may show Duplicate without its master. ${retry}`,
      { cause: error }
    );
  }
  throw new Error(
    `${identifier} could not be confirmed under ${master} by the read-back, so it was moved back to ${prior.state.name}. ${retry}`
  );
}

/**
 * One routing write. Reads the ticket, resolves every name to an id, unions
 * the labels to add with the labels already on the ticket, takes the assignee
 * from `inheritAssigneeFrom` when that issue has one and from `assignee`
 * otherwise, and resolves a match's open master as the parent. Duplicate is
 * set only when the report joins that master in the same call, read back
 * before success; with no eligible master the report stays open, related to
 * the match and labelled for grouping (ENG-17138). The duplicate relation is
 * written first, because Linear refuses to move a ticket to the Duplicate
 * state without one ("missing duplicate relation", ENG-15734, ENG-15935,
 * ENG-15785); a failed relation fails the call. Then one `issueUpdate`, the
 * link attachments, and the read-back. Unknown label names fail before any
 * write and list the team's labels.
 */
export async function routeTicket(
  input: RouteTicketInput,
  opts?: LinearGraphqlOptions & DuplicateRouting
): Promise<RouteTicketResult> {
  const gql: Gql = (query, variables) => linearGraphql(query, variables, opts);
  const issue = await requireIssue(gql, input.issue);
  const routed = await planRoute(gql, issue, input, opts ?? {});
  const { match, parent, warnings } = routed;
  const built = await buildUpdate(gql, issue, routed.owned, parent);
  warnings.push(...built.warnings);

  // Caller cancellation is never a warning; the tool rethrows it.
  const warn = (error: unknown, message: string) => {
    if (opts?.signal?.aborted) {
      throw error;
    }
    warnings.push(`${message}: ${reason(error)}`);
  };

  const related = match
    ? await writeMatchRelation(
        gql,
        issue,
        match,
        routed.closes ? "duplicate" : "related",
        opts?.signal
      )
    : null;
  // A relation-only or links-only call has no issueUpdate; then the relation
  // and links are the write, and a routed result needs at least one to land.
  let wrote = related !== null;
  if (Object.keys(built.update).length > 0) {
    await writeUpdate(gql, issue, built.update, {
      duplicateOf: related,
      matchField: input.relatedTo === undefined ? "duplicateOf" : "relatedTo",
      parent,
      relation: routed.closes ? "duplicate" : "related",
      signal: opts?.signal,
    });
    wrote = true;
  }
  // The writes above are the routing. Anything after them that fails is
  // reported as a warning on a routed result, never as an unrouted ticket.
  const linked = await writeLinks(gql, issue, input.links, warn);
  if (!(wrote || linked) && warnings.length > 0) {
    throw new Error(`Nothing was written. ${warnings.join(" ")}`);
  }
  const after = await readBackRouted(
    gql,
    input,
    issue,
    routed.keepsState && named(input.state, "duplicate") ? parent : undefined,
    warn,
    opts?.signal
  );
  return toResult(after ?? issue, warnings, {
    duplicateOf: routed.closes ? related : null,
    grouping: groupingOutcome(routed),
  });
}
