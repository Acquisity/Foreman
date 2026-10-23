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
  findComment: (id: string) => Promise<{ parentId: string | null } | null>;
  postUnderAnchor: (
    issueId: string,
    anchorId: string,
    body: string,
    id: string
  ) => Promise<string>;
  readTicket: (identifier: string) => Promise<TicketView | null>;
  recentIdentifiers: (
    updatedSince: string,
    createdAfter: string
  ) => Promise<string[]>;
}

type Fetch = typeof fetch;
type Variables = NonNullable<
  Parameters<typeof callLinearGraphQL>[0]["variables"]
>;

const ASK_FROM = /^Ask from /u;
const ASK_FROM_TITLE = "Ask from ";
const ANCHOR_LINK = /\]\((https:\/\/[^\s)]+)\)/u;
const RECENT_PAGES = 5;

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

const RECENT_QUERY = `query ReporterRecent($team: ID!, $since: DateTimeOrDuration!, $created: DateTimeOrDuration!, $ask: String!, $after: String) {
  issues(first: 100, after: $after, filter: {
    team: { id: { eq: $team } }
    updatedAt: { gt: $since }
    createdAt: { gt: $created }
    attachments: { some: { title: { startsWith: $ask } } }
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
const threadChannel = (
  asks: readonly { title: string; url: string }[],
  anchors: readonly { body: string }[]
): string | null => {
  const channels = [
    ...asks
      .filter((node) => ASK_FROM.test(node.title.trim()))
      .map((node) => slackChannelOf(node.url))
      .filter((channel) => channel !== null),
    ...anchors.map((anchor) => {
      const link = ANCHOR_LINK.exec(anchor.body)?.[1];
      return link ? slackChannelOf(link) : undefined;
    }),
  ];
  const [first] = channels;
  return first && channels.every((channel) => channel === first) ? first : null;
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
    recentIdentifiers(updatedSince, createdAfter) {
      const page = async (
        after: string | null,
        remaining: number
      ): Promise<string[]> => {
        const data = recentSchema.parse(
          await call(RECENT_QUERY, "ReporterRecent", {
            after,
            ask: ASK_FROM_TITLE,
            created: createdAfter,
            since: updatedSince,
            team: ENGINEERING_TEAM_ID,
          })
        );
        const here = data.issues.nodes.map((node) => node.identifier);
        const { endCursor, hasNextPage } = data.issues.pageInfo;
        return hasNextPage && endCursor && remaining > 1
          ? [...here, ...(await page(endCursor, remaining - 1))]
          : here;
      };
      return page(null, RECENT_PAGES);
    },
  };
};
