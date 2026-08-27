/**
 * Direct Linear GraphQL access for authored tools, sharing the app-scoped
 * `linearAuth` installation with the MCP connection. The token is sent only
 * as a bearer header and never appears in errors or results.
 */

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const REQUEST_TIMEOUT_MS = 15_000;

export interface LinearGraphqlOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Runs one GraphQL operation. A non-2xx response or a GraphQL `errors` array
 * throws an Error carrying the messages and nothing else.
 */
export async function linearGraphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  opts?: LinearGraphqlOptions
): Promise<T> {
  const fetchImpl = opts?.fetch ?? fetch;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetchImpl(LINEAR_GRAPHQL_URL, {
    body: JSON.stringify({ query, variables }),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  });
  if (!response.ok) {
    throw new Error(`Linear GraphQL request failed: HTTP ${response.status}.`);
  }
  const body = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };
  if (body.errors?.length) {
    const messages = body.errors
      .map((error) => error.message ?? "unknown error")
      .join("; ");
    throw new Error(`Linear GraphQL error: ${messages}`);
  }
  if (body.data === undefined) {
    throw new Error("Linear GraphQL response carried no data.");
  }
  return body.data;
}

/** Engineering Team id. The name alone silently returns nothing. */
export const ENGINEERING_TEAM_ID = "8eaf95ab-56ac-4490-8253-f6a96793dc40";

/** Recency window for eligible masters in intake-only Slack sessions. */
export const MASTER_WINDOW_DAYS = 30;

const DUPLICATES_PAGE_SIZE = 50;
const MASTERS_PAGE_SIZE = 250;
const MAX_PAGES = 20;
const MAX_ISSUES = 100;

const ISSUES_QUERY = `query RelatedIssues($filter: IssueFilter!, $first: Int!, $after: String, $includeArchived: Boolean!) {
  issues(filter: $filter, first: $first, after: $after, includeArchived: $includeArchived, orderBy: createdAt) {
    nodes {
      id identifier title url createdAt
      state { name type }
      assignee { name }
      parent { identifier }
      labels { nodes { name } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

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

const phraseFilter = (phrase: string) => ({
  or: [
    { title: { containsIgnoreCase: phrase } },
    { description: { containsIgnoreCase: phrase } },
  ],
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
  token: string,
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
      token,
      ISSUES_QUERY,
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
  token: string,
  input: FindRelatedIssuesInput,
  opts?: LinearGraphqlOptions & { now?: Date }
): Promise<FindRelatedIssuesResult> {
  const masters = input.scope === "masters";
  const createdAfter =
    masters && input.windowed
      ? new Date(
          (opts?.now ?? new Date()).getTime() -
            MASTER_WINDOW_DAYS * 24 * 60 * 60 * 1000
        ).toISOString()
      : null;

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
    if (await searchPhrase(token, phrase, filter, masters, byId, opts)) {
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

const ISSUE_DOCUMENTS_QUERY = `query IssueDocuments($id: String!, $title: String!) {
  issue(id: $id) {
    id identifier
    documents(filter: { title: { eq: $title } }, first: 50) { nodes { id title } }
  }
}`;

const DOCUMENT_CREATE = `mutation CreateDocument($input: DocumentCreateInput!) {
  documentCreate(input: $input) { success document { id updatedAt url } }
}`;

const DOCUMENT_UPDATE = `mutation UpdateDocument($id: String!, $input: DocumentUpdateInput!) {
  documentUpdate(id: $id, input: $input) { success document { id updatedAt url } }
}`;

const DOCUMENT_QUERY = `query Document($id: String!) {
  document(id: $id) { id updatedAt url }
}`;

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
  token: string,
  input: { content: string; issue: string; lane: InvestigationLane },
  opts?: LinearGraphqlOptions
): Promise<SaveInvestigationDocumentResult> {
  const title = DOCUMENT_TITLES[input.lane];
  const { issue } = await linearGraphql<{
    issue: {
      documents: { nodes: Array<{ id: string; title: string }> };
      id: string;
    };
  }>(token, ISSUE_DOCUMENTS_QUERY, { id: input.issue, title }, opts);

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
      token,
      DOCUMENT_UPDATE,
      { id: existing.id, input: { content: input.content, title } },
      opts
    );
    return { created: false, ...(await readBack(token, documentUpdate, opts)) };
  }
  const { documentCreate } = await linearGraphql<{
    documentCreate: DocumentPayload;
  }>(
    token,
    DOCUMENT_CREATE,
    { input: { content: input.content, issueId: issue.id, title } },
    opts
  );
  return { created: true, ...(await readBack(token, documentCreate, opts)) };
}

async function readBack(
  token: string,
  payload: DocumentPayload,
  opts?: LinearGraphqlOptions
) {
  if (!payload.success) {
    throw new Error("Linear did not confirm the document write.");
  }
  try {
    const { document } = await linearGraphql<{
      document: { id: string; updatedAt: string; url: string };
    }>(token, DOCUMENT_QUERY, { id: payload.document.id }, opts);
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

const ROUTE_ISSUE_QUERY = `query RouteIssue($id: String!) {
  issue(id: $id) {
    id identifier
    team { id }
    labels { nodes { id name } }
    assignee { id name }
  }
}`;

const TEAM_LABELS_QUERY = `query TeamLabels($teamId: ID!, $after: String) {
  issueLabels(first: 250, after: $after, filter: { or: [{ team: { id: { eq: $teamId } } }, { team: { null: true } }] }) {
    nodes { id name }
    pageInfo { hasNextPage endCursor }
  }
}`;
const MAX_LABEL_PAGES = 8;

interface LabelPage {
  nodes: Named[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
}

const WORKFLOW_STATES_QUERY = `query WorkflowStates($teamId: ID!, $name: String!) {
  workflowStates(first: 5, filter: { team: { id: { eq: $teamId } }, name: { eqIgnoreCase: $name } }) {
    nodes { id name }
  }
}`;

const PROJECTS_QUERY = `query Projects($name: String!, $teamId: ID!) {
  projects(first: 5, filter: { name: { eqIgnoreCase: $name }, accessibleTeams: { some: { id: { eq: $teamId } } } }) {
    nodes { id name }
  }
}`;

const USERS_QUERY = `query Users($name: String!) {
  users(first: 5, filter: { or: [{ email: { eq: $name } }, { name: { eqIgnoreCase: $name } }, { displayName: { eqIgnoreCase: $name } }] }) {
    nodes { id name }
  }
}`;

const ISSUE_UPDATE = `mutation RouteIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

const RELATION_CREATE = `mutation RouteRelation($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) { success }
}`;

const ATTACHMENT_LINK = `mutation RouteAttachment($issueId: String!, $url: String!, $title: String!) {
  attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success }
}`;

const ROUTE_READ_BACK = `query RouteReadBack($id: String!) {
  issue(id: $id) {
    identifier url priority
    state { name }
    labels { nodes { name } }
    project { id name }
    assignee { name }
    parent { identifier }
  }
}`;

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
  state?: string;
}

export interface RouteTicketResult {
  assignee: string | null;
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
  const { issue } = await gql<{ issue: RouteIssue | null }>(ROUTE_ISSUE_QUERY, {
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

type Gql = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;

interface RouteIssue {
  assignee: Named | null;
  id: string;
  identifier: string;
  labels: { nodes: Named[] };
  team: { id: string };
}

/** Unions the labels to add with the ticket's current labels; unknown names throw before any write. */
async function resolveLabelIds(
  gql: Gql,
  issue: RouteIssue,
  addLabels: string[]
): Promise<string[]> {
  const labels: Named[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_LABEL_PAGES; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: label pages are sequential cursors.
    const { issueLabels }: { issueLabels: LabelPage } = await gql<{
      issueLabels: LabelPage;
    }>(TEAM_LABELS_QUERY, { after, teamId: issue.team.id });
    labels.push(...issueLabels.nodes);
    after = issueLabels.pageInfo.hasNextPage
      ? issueLabels.pageInfo.endCursor
      : null;
    if (!after) {
      break;
    }
  }
  const byName = new Map(
    labels.map((label) => [label.name.toLowerCase(), label.id])
  );
  const unknown = addLabels.filter((name) => !byName.has(name.toLowerCase()));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown label${unknown.length > 1 ? "s" : ""} ${unknown.map((name) => `"${name}"`).join(", ")}. Valid labels: ${labels
        .map((label) => label.name)
        .sort((a, b) => a.localeCompare(b))
        .join(", ")}.`
    );
  }
  return [
    ...new Set([
      ...issue.labels.nodes.map((label) => label.id),
      ...addLabels.map((name) => byName.get(name.toLowerCase()) ?? ""),
    ]),
  ].filter(Boolean);
}

/**
 * The assignee id: the source issue's assignee when `inheritAssigneeFrom` is
 * given and that issue has one; otherwise `assignee` by name or email, which
 * therefore acts as the fallback for an unassigned master.
 */
async function resolveAssigneeId(
  gql: Gql,
  input: RouteTicketInput
): Promise<string | undefined> {
  if (input.inheritAssigneeFrom !== undefined) {
    const source = await requireIssue(gql, input.inheritAssigneeFrom);
    if (source.assignee) {
      return source.assignee.id;
    }
  }
  if (input.assignee !== undefined) {
    const { users } = await gql<{ users: { nodes: Named[] } }>(USERS_QUERY, {
      name: input.assignee,
    });
    return exactlyOne("user", input.assignee, users.nodes);
  }
  return undefined;
}

/** Builds the single issueUpdate input from the decisions given. */
async function buildUpdate(
  gql: Gql,
  issue: RouteIssue,
  input: RouteTicketInput
): Promise<Record<string, unknown>> {
  const update: Record<string, unknown> = {};
  if (input.addLabels?.length) {
    update.labelIds = await resolveLabelIds(gql, issue, input.addLabels);
  }
  if (input.state !== undefined) {
    const { workflowStates } = await gql<{
      workflowStates: { nodes: Named[] };
    }>(WORKFLOW_STATES_QUERY, { name: input.state, teamId: issue.team.id });
    update.stateId = exactlyOne("state", input.state, workflowStates.nodes);
  }
  if (input.priority !== undefined) {
    update.priority = input.priority;
  }
  if (input.project !== undefined) {
    const { projects } = await gql<{ projects: { nodes: Named[] } }>(
      PROJECTS_QUERY,
      { name: input.project, teamId: issue.team.id }
    );
    update.projectId = exactlyOne(
      "project on the ticket's team",
      input.project,
      projects.nodes
    );
  }
  const assigneeId = await resolveAssigneeId(gql, input);
  if (assigneeId !== undefined) {
    update.assigneeId = assigneeId;
  }
  if (input.parent !== undefined) {
    update.parentId = (await requireIssue(gql, input.parent)).id;
  }
  return update;
}

/**
 * One routing write. Reads the ticket, resolves every name to an id, unions
 * the labels to add with the labels already on the ticket, takes the assignee
 * from `inheritAssigneeFrom` when that issue has one and from `assignee`
 * otherwise, runs one
 * `issueUpdate`, then the optional duplicate relation and link attachments,
 * and reads the ticket back. Unknown label names fail before any write and
 * list the team's labels.
 */
export async function routeTicket(
  token: string,
  input: RouteTicketInput,
  opts?: LinearGraphqlOptions
): Promise<RouteTicketResult> {
  const gql: Gql = (query, variables) =>
    linearGraphql(token, query, variables, opts);

  const issue = await requireIssue(gql, input.issue);

  const update = await buildUpdate(gql, issue, input);
  // Resolve the duplicate target before the first write, so a bad identifier
  // fails the whole call rather than leaving a routed ticket with no relation.
  const master =
    input.duplicateOf === undefined
      ? null
      : await requireIssue(gql, input.duplicateOf);
  if (Object.keys(update).length > 0) {
    const { issueUpdate } = await gql<{ issueUpdate: { success: boolean } }>(
      ISSUE_UPDATE,
      { id: issue.id, input: update }
    );
    if (!issueUpdate.success) {
      throw new Error("Linear did not confirm the issue update.");
    }
  }

  // The update above is the write. Anything after it that fails is reported
  // as a warning on a routed result, never as an unrouted ticket.
  const warnings: string[] = [];
  const reason = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

  if (master) {
    try {
      const { issueRelationCreate } = await gql<{
        issueRelationCreate: { success: boolean };
      }>(RELATION_CREATE, {
        input: {
          issueId: issue.id,
          relatedIssueId: master.id,
          type: "duplicate",
        },
      });
      if (!issueRelationCreate.success) {
        throw new Error("Linear did not confirm the relation.");
      }
    } catch (error) {
      warnings.push(
        `Duplicate relation to ${input.duplicateOf} was not recorded: ${reason(error)}`
      );
    }
  }

  for (const link of input.links ?? []) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: attachments are written one at a time so a failure names the link.
      const { attachmentLinkURL } = await gql<{
        attachmentLinkURL: { success: boolean };
      }>(ATTACHMENT_LINK, {
        issueId: issue.id,
        title: link.title,
        url: link.url,
      });
      if (!attachmentLinkURL.success) {
        throw new Error("Linear did not confirm the attachment.");
      }
    } catch (error) {
      warnings.push(`Link ${link.url} was not attached: ${reason(error)}`);
    }
  }

  const { issue: saved } = await gql<{
    issue: {
      assignee: Named | null;
      identifier: string;
      labels: { nodes: Named[] };
      parent: { identifier: string } | null;
      priority: number;
      project: Named | null;
      state: { name: string };
      url: string;
    };
  }>(ROUTE_READ_BACK, { id: issue.id });

  return {
    assignee: saved.assignee?.name ?? null,
    identifier: saved.identifier,
    labels: saved.labels.nodes.map((label) => label.name),
    parentIdentifier: saved.parent?.identifier ?? null,
    priority: saved.priority,
    projectId: saved.project?.id ?? null,
    projectName: saved.project?.name ?? null,
    state: saved.state.name,
    url: saved.url,
    warnings,
  };
}
