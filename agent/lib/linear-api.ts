import { type ProviderClient, requiredClient } from "./executor/operations.js";
import type { LinearOperation } from "./linear-operations.js";
import { parseLinearResponse } from "./linear-response.js";

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

export interface IssueNode {
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

export interface IssuesData {
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
export const phraseFilter = (phrase: string) => ({
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
