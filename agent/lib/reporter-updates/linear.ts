import { callLinearGraphQL } from "eve/channels/linear";
import { z } from "zod";
import { ENGINEERING_TEAM_ID } from "../linear-api.js";
import { slackChannelOf } from "../linear-context.js";
import {
  assertThreadComplete,
  createThreadComment,
  SLACK_ANCHOR_PATTERN,
} from "../requester-reply.js";
import { parsePullUrl, type TicketFacts } from "./plan.js";

export interface ThreadComment {
  body: string;
  id: string;
}

export interface TicketView {
  anchorId: string | null;
  facts: TicketFacts;
  foremanComments: ThreadComment[];
  issueId: string;
}

export interface LinearPort {
  discover: (
    updatedSince: string,
    createdAfter: string,
    after: string | null
  ) => Promise<{ identifiers: string[]; next: string | null }>;
  findComment: (id: string) => Promise<{ parentId: string | null } | null>;
  postUnderAnchor: (
    issueId: string,
    anchorId: string,
    body: string,
    id: string
  ) => Promise<string>;
  readTicket: (identifier: string) => Promise<TicketView | null>;
}

type Fetch = typeof fetch;
type Variables = NonNullable<
  Parameters<typeof callLinearGraphQL>[0]["variables"]
>;

const ASK_FROM = /^Ask from /u;
const ANCHOR_PREFIX = "Slack thread connected in ";
const DISCOVER_PAGES = 20;
const ANCHOR_LINK = /\]\((https:\/\/[^\s)]+)\)/u;

const TICKET_QUERY = `query ReporterTicket($id: String!) {
  viewer { id }
  issue(id: $id) {
    id
    identifier
    createdAt
    state { name type }
    assignee { name }
    labels(first: 50) { nodes { name } }
    attachments(first: 50) { nodes { title url } }
    parent {
      identifier
      state { type }
      attachments(first: 50) { nodes { title url } }
    }
    comments(first: 100) {
      pageInfo { hasNextPage }
      nodes { id body createdAt parent { id } user { id } }
    }
  }
}`;

const COMMENT_QUERY = `query ReporterComment($id: String!) {
  comment(id: $id) { id parent { id } }
}`;

const DISCOVER_QUERY = `query ReporterDiscover($team: ID!, $since: DateTimeOrDuration!, $created: DateTimeOrDuration!, $anchor: String!, $after: String) {
  issues(first: 100, after: $after, orderBy: createdAt, filter: {
    team: { id: { eq: $team } }
    createdAt: { gt: $created }
    comments: { some: { body: { startsWith: $anchor } } }
    or: [{ updatedAt: { gt: $since } }, { parent: { updatedAt: { gt: $since } } }]
  }) {
    pageInfo { hasNextPage endCursor }
    nodes { identifier }
  }
}`;

const attachments = z.object({
  nodes: z.array(z.object({ title: z.string(), url: z.string() })),
});
const ticketSchema = z.object({
  issue: z
    .object({
      assignee: z.object({ name: z.string() }).nullable(),
      attachments,
      comments: z.object({
        nodes: z.array(
          z.object({
            body: z.string(),
            createdAt: z.string(),
            id: z.string(),
            parent: z.object({ id: z.string() }).nullable(),
            user: z.object({ id: z.string() }).nullable(),
          })
        ),
        pageInfo: z.object({ hasNextPage: z.boolean() }),
      }),
      createdAt: z.string(),
      id: z.string(),
      identifier: z.string(),
      labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
      parent: z
        .object({
          attachments,
          identifier: z.string(),
          state: z.object({ type: z.string() }),
        })
        .nullable(),
      state: z.object({ name: z.string(), type: z.string() }),
    })
    .nullable(),
  viewer: z.object({ id: z.string() }),
});
const commentSchema = z.object({
  comment: z
    .object({ id: z.string(), parent: z.object({ id: z.string() }).nullable() })
    .nullable(),
});
const recentSchema = z.object({
  issues: z.object({
    nodes: z.array(z.object({ identifier: z.string() })),
    pageInfo: z.object({
      endCursor: z.string().nullable(),
      hasNextPage: z.boolean(),
    }),
  }),
});
const QUERY_START = /\?.*$/u;

const threadKey = (url: string): string => url.replace(QUERY_START, "");

const threadChannel = (
  asks: readonly { title: string; url: string }[],
  anchors: readonly { body: string }[]
): string | null => {
  const owned = anchors.map((anchor) => {
    const link = ANCHOR_LINK.exec(anchor.body)?.[1];
    return {
      channel: link ? slackChannelOf(link) : null,
      thread: link ? threadKey(link) : null,
    };
  });
  const askThreads = asks
    .filter(
      (node) =>
        ASK_FROM.test(node.title.trim()) && slackChannelOf(node.url) !== null
    )
    .map((node) => threadKey(node.url));
  const destinations =
    askThreads.length === 0
      ? owned
      : owned.filter(
          (anchor) => anchor.thread && askThreads.includes(anchor.thread)
        );
  const [first] = destinations;
  return first?.channel &&
    destinations.every((destination) => destination.channel === first.channel)
    ? first.channel
    : null;
};

const REQUEST_TIMEOUT_MS = 20_000;

export const linearPort = (
  accessToken: string,
  fetchImpl: Fetch = fetch,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): LinearPort => {
  const timed: Fetch = (input, init) =>
    fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const call = <T>(query: string, queryName: string, variables: Variables) =>
    callLinearGraphQL<T>({
      api: { fetch: timed },
      credentials: { accessToken },
      query,
      queryName,
      variables,
    });
  return {
    async discover(updatedSince, createdAfter, after) {
      const identifiers: string[] = [];
      const page = async (
        cursor: string | null,
        remaining: number
      ): Promise<string | null> => {
        const data = recentSchema.parse(
          await call(DISCOVER_QUERY, "ReporterDiscover", {
            after: cursor,
            anchor: ANCHOR_PREFIX,
            created: createdAfter,
            since: updatedSince,
            team: ENGINEERING_TEAM_ID,
          })
        );
        identifiers.push(...data.issues.nodes.map((node) => node.identifier));
        const { endCursor, hasNextPage } = data.issues.pageInfo;
        if (!(hasNextPage && endCursor)) {
          return null;
        }
        return remaining > 1 ? page(endCursor, remaining - 1) : endCursor;
      };
      const next = await page(after, DISCOVER_PAGES);
      return { identifiers, next };
    },
    async findComment(id) {
      try {
        const data = commentSchema.parse(
          await call(COMMENT_QUERY, "ReporterComment", { id })
        );
        return data.comment
          ? { parentId: data.comment.parent?.id ?? null }
          : null;
      } catch {
        return null;
      }
    },
    async postUnderAnchor(issueId, anchorId, body, id) {
      const created = await createThreadComment({
        api: { fetch: timed },
        body,
        credentials: { accessToken },
        id,
        issueId,
        parentId: anchorId,
      });
      return created.id;
    },
    async readTicket(identifier) {
      const data = ticketSchema.parse(
        await call(TICKET_QUERY, "ReporterTicket", { id: identifier })
      );
      const { issue } = data;
      if (!issue) {
        return null;
      }
      assertThreadComplete(identifier, issue.comments.pageInfo.hasNextPage);
      const comments = issue.comments.nodes;
      const anchors = comments
        .filter(
          (comment) =>
            !comment.parent && SLACK_ANCHOR_PATTERN.test(comment.body.trim())
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const anchor = anchors.at(0);
      const pullUrls = [
        ...issue.attachments.nodes,
        ...(issue.parent?.attachments.nodes ?? []),
      ]
        .map((node) => node.url.trim())
        .filter((url) => parsePullUrl(url) !== null);
      return {
        anchorId: anchor?.id ?? null,
        facts: {
          assignee: issue.assignee?.name ?? null,
          channel: anchor
            ? threadChannel(issue.attachments.nodes, anchors)
            : null,
          createdAt: issue.createdAt,
          identifier: issue.identifier,
          labels: issue.labels.nodes.map((label) => label.name),
          parent: issue.parent
            ? {
                identifier: issue.parent.identifier,
                stateType: issue.parent.state.type,
              }
            : null,
          pullUrls: [...new Set(pullUrls)],
          stateName: issue.state.name,
          stateType: issue.state.type,
        },
        foremanComments: comments
          .filter(
            (comment) =>
              anchor &&
              comment.parent?.id === anchor.id &&
              comment.user?.id === data.viewer.id
          )
          .map((comment) => ({ body: comment.body, id: comment.id })),
        issueId: issue.id,
      };
    },
  };
};
