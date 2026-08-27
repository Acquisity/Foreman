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
  updatedAt: string;
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
  const { document } = await linearGraphql<{
    document: { id: string; updatedAt: string; url: string };
  }>(token, DOCUMENT_QUERY, { id: payload.document.id }, opts);
  return {
    documentId: document.id,
    updatedAt: document.updatedAt,
    url: document.url,
  };
}
