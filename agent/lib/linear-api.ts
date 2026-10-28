import { type ProviderClient, requiredClient } from "./executor/operations.js";
import type { LinearOperation } from "./linear-operations.js";
import { parseLinearResponse } from "./linear-response.js";
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

/** Fixed Linear GraphQL operations. The injected Executor transport supplies provider authentication; this module retains routing and document semantics. */

const REQUEST_TIMEOUT_MS = 15_000;

export interface LinearGraphqlOptions {
  client?: ProviderClient;
  signal?: AbortSignal;
}

/**
 * Runs one GraphQL operation. A non-2xx response or a GraphQL `errors` array
 * throws an Error carrying the messages and nothing else.
 */
export async function linearGraphql<T>(
  operation: LinearOperation,
  variables: Record<string, unknown>,
  opts?: LinearGraphqlOptions
): Promise<T> {
  const client = requiredClient(opts?.client);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await client(
    { input: { variables }, operation: `linear.${operation}` },
    {
      signal: opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    }
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Linear GraphQL request failed: HTTP ${response.status}.`);
  }
  return parseLinearResponse(operation, response.data) as T;
}

/** Engineering Team id. The name alone silently returns nothing. */
export const ENGINEERING_TEAM_ID = "8eaf95ab-56ac-4490-8253-f6a96793dc40";

/** Recency window for eligible masters in intake-only Slack sessions. */
export const MASTER_WINDOW_DAYS = 30;

/** The creation time a master must reach, or null when no window applies. */
export const masterCreatedAfter = (
  windowed: boolean,
  now: Date = new Date()
): string | null =>
  windowed
    ? new Date(
        now.getTime() - MASTER_WINDOW_DAYS * 24 * 60 * 60 * 1000
      ).toISOString()
    : null;

const DUPLICATES_PAGE_SIZE = 50;
const MASTERS_PAGE_SIZE = 250;
const MAX_PAGES = 20;
const MAX_ISSUES = 100;

interface IssueNode {
  assignee: { name: string } | null;
  createdAt: string;
  id: string;
  identifier: string;
  labels: { nodes: Array<{ name: string }> };
  parent: { identifier: string } | null;
  state: { name: string; type: string };
  title: string;
  url: string;
}

interface IssuesData {
  issues: {
    nodes: IssueNode[];
    pageInfo: { endCursor: string | null; hasNextPage: boolean };
  };
}

export interface RelatedIssue {
  assignee: string | null;
  createdAt: string;
  identifier: string;
  labels: string[];
  matchedPhrases: string[];
  parentIdentifier: string | null;
  state: string;
  stateType: string;
  title: string;
  url: string;
}

export interface FindRelatedIssuesResult {
  /** ISO timestamp masters must be created at or after; null when unbounded. */
  createdAfter: string | null;
  issues: RelatedIssue[];
  /** A page cap or the result cap dropped candidates. */
  truncated: boolean;
}

export interface FindRelatedIssuesInput {
  phrases: string[];
  scope: "duplicates" | "masters";
  /** Apply the {@link MASTER_WINDOW_DAYS} window to `masters`; decided by the tool from the session stamp. */
  windowed: boolean;
}

/**
 * Every word of the phrase must appear in the title or description; the
 * whole phrase as one substring never matched the multi-word phrasings the
 * skills ask for (seen on ENG-13091: "growth plan creator empty sections"
 * missed a master carrying every one of those words).
 */
const WORDS = /\s+/u;
const phraseFilter = (phrase: string) => ({
  and: phrase.split(WORDS).map((word) => ({
    or: [
      { title: { containsIgnoreCase: word } },
      { description: { containsIgnoreCase: word } },
    ],
  })),
});

const toRelatedIssue = (node: IssueNode, phrase: string): RelatedIssue => ({
  assignee: node.assignee?.name ?? null,
  createdAt: node.createdAt,
  identifier: node.identifier,
  labels: node.labels.nodes.map((label) => label.name),
  matchedPhrases: [phrase],
  parentIdentifier: node.parent?.identifier ?? null,
  state: node.state.name,
  stateType: node.state.type,
  title: node.title,
  url: node.url,
});

/** Runs one phrase's query, following cursors, merging into `byId`. Returns whether pages were dropped. */
async function searchPhrase(
  phrase: string,
  filter: Record<string, unknown>,
  masters: boolean,
  byId: Map<string, RelatedIssue>,
  opts?: LinearGraphqlOptions
): Promise<boolean> {
  let after: string | null = null;
  let pages = 0;
  do {
    // biome-ignore lint/performance/noAwaitInLoops: cursors are sequential.
    const data: IssuesData = await linearGraphql<IssuesData>(
      "RelatedIssues",
      {
        after,
        filter,
        first: masters ? MASTERS_PAGE_SIZE : DUPLICATES_PAGE_SIZE,
        includeArchived: !masters,
      },
      opts
    );
    for (const node of data.issues.nodes) {
      const existing = byId.get(node.id);
      if (existing) {
        existing.matchedPhrases.push(phrase);
      } else {
        byId.set(node.id, toRelatedIssue(node, phrase));
      }
    }
    pages += 1;
    after = data.issues.pageInfo.hasNextPage
      ? data.issues.pageInfo.endCursor
      : null;
    if (after && (!masters || pages >= MAX_PAGES)) {
      return true;
    }
  } while (after);
  return false;
}

/**
 * The two fixed searches. `duplicates` runs one page per phrase across every
 * team, archived included. `masters` runs the Engineering Team, fully
 * paginated, optionally within the recency window. Results are merged and
 * deduped by id, each carrying the phrases that matched it.
 */
export async function findRelatedIssues(
  input: FindRelatedIssuesInput,
  opts?: LinearGraphqlOptions & { now?: Date }
): Promise<FindRelatedIssuesResult> {
  const masters = input.scope === "masters";
  const createdAfter = masterCreatedAfter(masters && input.windowed, opts?.now);

  const byId = new Map<string, RelatedIssue>();
  let truncated = false;
  for (const phrase of new Set(input.phrases)) {
    const filter: Record<string, unknown> = masters
      ? {
          ...phraseFilter(phrase),
          team: { id: { eq: ENGINEERING_TEAM_ID } },
          ...(createdAfter ? { createdAt: { gte: createdAfter } } : {}),
        }
      : phraseFilter(phrase);
    // biome-ignore lint/performance/noAwaitInLoops: phrases run one at a time to keep Linear rate limits and result order predictable.
    if (await searchPhrase(phrase, filter, masters, byId, opts)) {
      truncated = true;
    }
  }

  const issues = [...byId.values()];
  return {
    createdAfter,
    issues: issues.slice(0, MAX_ISSUES),
    truncated: truncated || issues.length > MAX_ISSUES,
  };
}

/** Fixed document titles per investigation lane. */
export const DOCUMENT_TITLES = {
  billing: "Billing investigation",
  triage: "Triage investigation",
} as const;

export type InvestigationLane = keyof typeof DOCUMENT_TITLES;

/** Upper bound on document content, matching the skills' 20 KB handoff rule. */
export const DOCUMENT_MAX_CHARS = 20_000;

interface DocumentPayload {
  document: { id: string; updatedAt: string; url: string };
  success: boolean;
}

export interface SaveInvestigationDocumentResult {
  created: boolean;
  documentId: string;
  /** Set when the write succeeded but the version pin could not be read back. */
  error?: string;
  /** The post-write version pin; absent only when `error` is set. */
  updatedAt?: string;
  url: string;
}

/**
 * Creates the lane's issue-scoped document on first call and rewrites it on
 * later calls, so a ticket never carries two. The document is read back after
 * the write because the mutation response reports the pre-write `updatedAt`;
 * the read-back value is the version pin the critic packet needs.
 */
export async function saveInvestigationDocument(
  input: { content: string; issue: string; lane: InvestigationLane },
  opts?: LinearGraphqlOptions
): Promise<SaveInvestigationDocumentResult> {
  const title = DOCUMENT_TITLES[input.lane];
  const { issue } = await linearGraphql<{
    issue: {
      documents: { nodes: Array<{ id: string; title: string }> };
      id: string;
    };
  }>("IssueDocuments", { id: input.issue, title }, opts);

  const matches = issue.documents.nodes.filter((node) => node.title === title);
  if (matches.length > 1) {
    throw new Error(
      `${input.issue} already carries ${matches.length} documents titled "${title}"; consolidate them by hand before saving.`
    );
  }
  const [existing] = matches;
  if (existing) {
    const { documentUpdate } = await linearGraphql<{
      documentUpdate: DocumentPayload;
    }>(
      "UpdateDocument",
      { id: existing.id, input: { content: input.content, title } },
      opts
    );
    return { created: false, ...(await readBack(documentUpdate, opts)) };
  }
  const { documentCreate } = await linearGraphql<{
    documentCreate: DocumentPayload;
  }>(
    "CreateDocument",
    { input: { content: input.content, issueId: issue.id, title } },
    opts
  );
  return { created: true, ...(await readBack(documentCreate, opts)) };
}

/**
 * The URLs of the investigation documents attached to a ticket, the documents
 * where triage and staff record a change; decide_triage counts a document as
 * change evidence only when it is one of these.
 */
export async function ticketDocumentUrls(
  identifier: string,
  opts?: LinearGraphqlOptions
): Promise<string[]> {
  const lists = await Promise.all(
    Object.values(DOCUMENT_TITLES).map((title) =>
      linearGraphql<{
        issue: { documents: { nodes: Array<{ id: string }> } };
      }>("IssueDocuments", { id: identifier, title }, opts)
    )
  );
  const documents = await Promise.all(
    lists
      .flatMap(({ issue }) => issue.documents.nodes)
      .map(({ id }) =>
        linearGraphql<{ document: { url: string } }>("Document", { id }, opts)
      )
  );
  return documents.map(({ document }) => document.url);
}

async function readBack(payload: DocumentPayload, opts?: LinearGraphqlOptions) {
  if (!payload.success) {
    throw new Error("Linear did not confirm the document write.");
  }
  try {
    const { document } = await linearGraphql<{
      document: { id: string; updatedAt: string; url: string };
    }>("Document", { id: payload.document.id }, opts);
    return {
      documentId: document.id,
      updatedAt: document.updatedAt,
      url: document.url,
    };
  } catch (error) {
    // The write is in Linear; only the pin is missing. A repeat call with the
    // same content rewrites it and returns the pin.
    return {
      documentId: payload.document.id,
      error: `The document was written, but its version pin could not be read back (${error instanceof Error ? error.message : "read failed"}). Call again with the same content to get updatedAt.`,
      url: payload.document.url,
    };
  }
}

/* ----------------------------- route_ticket ----------------------------- */

/** Read before the update and again after it; both reads share one shape. */

const MAX_LABEL_PAGES = 8;

interface LabelPage {
  nodes: Named[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
}

interface Named {
  id: string;
  name: string;
}

export interface RouteTicketInput {
  addLabels?: string[];
  assignee?: string;
  duplicateOf?: string;
  inheritAssigneeFrom?: string;
  issue: string;
  links?: Array<{ title: string; url: string }>;
  parent?: string;
  priority?: number;
  project?: string;
  releaseDeveloper?: boolean;
  removeLabels?: string[];
  state?: string;
}

export interface RouteTicketResult {
  assignee: string | null;
  duplicateOf: string | null;
  identifier: string;
  labels: string[];
  parentIdentifier: string | null;
  priority: number;
  projectId: string | null;
  projectName: string | null;
  state: string;
  url: string;
  /** Steps after the issue update that failed; the update itself landed. */
  warnings: string[];
}

/** Reads one issue by identifier, throwing when Linear has no such issue. */
async function requireIssue(gql: Gql, identifier: string): Promise<RouteIssue> {
  const { issue } = await gql<{ issue: RouteIssue | null }>("RouteIssue", {
    id: identifier,
  });
  if (!issue) {
    throw new Error(`No issue ${identifier}.`);
  }
  return issue;
}

/** Resolves one name to exactly one id, or throws naming what was found. */
function exactlyOne(kind: string, name: string, nodes: Named[]): string {
  if (nodes.length === 1 && nodes[0]) {
    return nodes[0].id;
  }
  if (nodes.length === 0) {
    throw new Error(`No ${kind} named "${name}".`);
  }
  throw new Error(
    `${nodes.length} ${kind}s match "${name}": ${nodes.map((node) => node.name).join(", ")}.`
  );
}

type Gql = <T>(
  operation: LinearOperation,
  variables: Record<string, unknown>
) => Promise<T>;

interface RouteIssue {
  assignee: Named | null;
  id: string;
  identifier: string;
  labels: { nodes: Named[] };
  parent: { identifier: string } | null;
  priority: number;
  project: Named | null;
  state: { name: string };
  team: { id: string };
  url: string;
}

const toResult = (
  issue: RouteIssue,
  warnings: string[],
  duplicateOf: string | null
): RouteTicketResult => ({
  assignee: issue.assignee?.name ?? null,
  duplicateOf,
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
  const removed = new Set(
    (input.removeLabels ?? []).map((name) => name.toLowerCase())
  );
  const kept = issue.labels.nodes.filter(
    (label) => !removed.has(label.name.toLowerCase())
  );
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
 * The labels a customer report carries and a master never does: masters have
 * no marker label (engineering-handoff), and every report gets its source
 * labels from classify_ask.
 */
const REPORT_LABELS = new Set(
  ["Customer reported", "Internal reported", "intercom-sourced"].map((name) =>
    name.toLowerCase()
  )
);

const isReport = (issue: RouteIssue): boolean =>
  issue.labels.nodes.some((label) =>
    REPORT_LABELS.has(label.name.toLowerCase())
  );

/** Whether the ticket carries the Bug label once this call's label changes land. */
const carriesBug = (issue: RouteIssue, input: RouteTicketInput): boolean => {
  const removed = new Set(
    (input.removeLabels ?? []).map((name) => name.toLowerCase())
  );
  return [
    ...issue.labels.nodes
      .map((label) => label.name)
      .filter((name) => !removed.has(name.toLowerCase())),
    ...(input.addLabels ?? []),
  ].some((name) => name.toLowerCase() === BUG_LABEL.toLowerCase());
};

export interface DuplicateRouting {
  /** The triage decision settled a Bug; the ticket's Bug label counts too. */
  masterRequired?: boolean;
  /** The master search cutoff for this session (`masterCreatedAfter`). */
  mastersCreatedAfter?: string | null;
}

/** Whether a master was created before the session's cutoff, read through the master search's own query. */
async function beforeCutoff(
  gql: Gql,
  identifier: string,
  cutoff: string | null
): Promise<boolean> {
  if (cutoff === null) {
    return false;
  }
  const { id } = await requireIssue(gql, identifier);
  const { issues } = await gql<IssuesData>("RelatedIssues", {
    after: null,
    filter: { id: { eq: id } },
    first: 1,
    includeArchived: true,
  });
  const createdAt = issues.nodes[0]?.createdAt;
  if (!createdAt) {
    throw new Error(
      `Could not read when ${identifier} was created, so nothing was written.`
    );
  }
  return Date.parse(createdAt) < Date.parse(cutoff);
}

const staleMaster = (identifier: string, cutoff: string | null) =>
  new Error(
    `${identifier} was created before ${cutoff}, so it cannot take new reports and nothing was written. Create a new master through engineering-handoff from this investigation (aggregate evidence only: no organization id, email or customer rows), relate ${identifier} for history, then call again with parent set to the new master.`
  );

/**
 * The parent a duplicate joins (ENG-16608): a match that is not a report is
 * the master itself; a report's parent is its master. A master created before
 * the session's master-search cutoff is not eligible. With no eligible master,
 * a Bug duplicate (by decision or by its Bug label) is refused until
 * engineering-handoff has made one; any other duplicate closes unparented.
 */
async function duplicateParent(
  gql: Gql,
  issue: RouteIssue,
  match: RouteIssue,
  input: RouteTicketInput,
  routing: DuplicateRouting
): Promise<string | undefined> {
  const cutoff = routing.mastersCreatedAfter ?? null;
  const found = isReport(match)
    ? (match.parent?.identifier ?? null)
    : match.identifier;
  const stale =
    found !== null && (await beforeCutoff(gql, found, cutoff)) ? found : null;
  if (found !== null && stale === null) {
    if (input.parent !== undefined && input.parent !== found) {
      throw new Error(
        `${match.identifier} belongs under its master ${found}, not ${input.parent}, so nothing was written. Drop parent or pass ${found}.`
      );
    }
    return found;
  }
  const required = routing.masterRequired || carriesBug(issue, input);
  if (input.parent !== undefined) {
    if (required && isReport(await requireIssue(gql, input.parent))) {
      throw new Error(
        `${input.parent} is a customer report, not a master, so nothing was written. Pass the master as parent, or create one through engineering-handoff first.`
      );
    }
    if (await beforeCutoff(gql, input.parent, cutoff)) {
      throw staleMaster(input.parent, cutoff);
    }
    return input.parent;
  }
  if (!required) {
    return;
  }
  if (stale !== null) {
    throw staleMaster(stale, cutoff);
  }
  throw new Error(
    `${match.identifier} is a customer report with no master, so nothing was written. Create the master through engineering-handoff from this investigation (aggregate evidence only: no organization id, email or customer rows), call route_ticket with issue ${match.identifier} and parent set to the new master, then call this again.`
  );
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

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The duplicate relation, written before the update; a failure writes nothing. */
async function writeDuplicateRelation(
  gql: Gql,
  issue: RouteIssue,
  match: RouteIssue,
  signal?: AbortSignal
): Promise<string> {
  try {
    const { issueRelationCreate } = await gql<{
      issueRelationCreate: { success: boolean };
    }>("RouteRelation", {
      input: { issueId: issue.id, relatedIssueId: match.id, type: "duplicate" },
    });
    if (!issueRelationCreate.success) {
      throw new Error("Linear did not confirm the relation.");
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw new Error(
      `Nothing was written: the duplicate relation to ${match.identifier} was not recorded (${reason(error)}).`,
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
  after: { duplicateOf: string | null; parent?: string; signal?: AbortSignal }
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
    throw new Error(
      `The duplicate relation to ${after.duplicateOf} was recorded, but the update failed (${reason(error)}). Call route_ticket again without duplicateOf${after.parent ? `, with parent ${after.parent}` : ""}, to apply the rest.`,
      { cause: error }
    );
  }
}

/**
 * One routing write. Reads the ticket, resolves every name to an id, unions
 * the labels to add with the labels already on the ticket, takes the assignee
 * from `inheritAssigneeFrom` when that issue has one and from `assignee`
 * otherwise, and resolves a duplicate's master as its parent. The duplicate
 * relation is written first, because Linear refuses to move a ticket to the
 * Duplicate state without one and then writes nothing ("missing duplicate
 * relation", ENG-15734, ENG-15935, ENG-15785); a failed relation fails the
 * call. Then one `issueUpdate`, the link attachments, and the read-back.
 * Unknown label names fail before any write and list the team's labels. Once
 * the update lands the result is always routed; a failed link or read-back
 * becomes a warning.
 */
export async function routeTicket(
  input: RouteTicketInput,
  opts?: LinearGraphqlOptions & DuplicateRouting
): Promise<RouteTicketResult> {
  const gql: Gql = (query, variables) => linearGraphql(query, variables, opts);

  const issue = await requireIssue(gql, input.issue);
  // Resolve the duplicate target before the first write, so a bad identifier
  // fails the whole call rather than leaving a routed ticket with no relation.
  const match =
    input.duplicateOf === undefined
      ? null
      : await requireIssue(gql, input.duplicateOf);
  const parent = match
    ? await duplicateParent(gql, issue, match, input, opts ?? {})
    : input.parent;
  // A duplicate takes its owner from the master it is parented under, so the
  // report and its master keep one owner even when the match is held by
  // someone else; the area owner stays the fallback.
  const owned =
    match && parent !== undefined && input.inheritAssigneeFrom !== undefined
      ? { ...input, inheritAssigneeFrom: parent }
      : input;
  const { update, warnings } = await buildUpdate(gql, issue, owned, parent);

  // Caller cancellation is never a warning; the tool rethrows it.
  const warn = (error: unknown, message: string) => {
    if (opts?.signal?.aborted) {
      throw error;
    }
    warnings.push(`${message}: ${reason(error)}`);
  };

  const duplicateOf = match
    ? await writeDuplicateRelation(gql, issue, match, opts?.signal)
    : null;
  // A relation-only or links-only call has no issueUpdate; then the relation
  // and links are the write, and a routed result needs at least one to land.
  let wrote = duplicateOf !== null;
  if (Object.keys(update).length > 0) {
    await writeUpdate(gql, issue, update, {
      duplicateOf,
      parent,
      signal: opts?.signal,
    });
    wrote = true;
  }

  // The writes above are the routing. Anything after them that fails is
  // reported as a warning on a routed result, never as an unrouted ticket.
  for (const link of input.links ?? []) {
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

  if (!wrote && warnings.length > 0) {
    throw new Error(`Nothing was written. ${warnings.join(" ")}`);
  }

  // The read-back is after the write too: when it fails, the ticket is still
  // routed, so report the pre-routing fields with a warning rather than a
  // failure that would send the caller back to route it again.
  try {
    return toResult(
      await requireIssue(gql, input.issue),
      warnings,
      duplicateOf
    );
  } catch (error) {
    warn(
      error,
      "The ticket was updated but could not be read back, so the fields below are from before routing"
    );
    return toResult(issue, warnings, duplicateOf);
  }
}
