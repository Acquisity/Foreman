import { callLinearGraphQL } from "eve/channels/linear";
import { z } from "zod";
import { ENGINEERING_TEAM_ID } from "../linear-api.js";
import { mappedOwner } from "../owner-map.js";
import {
  assertThreadComplete,
  createThreadComment,
  SLACK_ANCHOR_PATTERN,
} from "../requester-reply.js";
import { isReporterUpdate } from "./copy.js";
import { type ClosingComment, parsePullUrl, type TicketFacts } from "./plan.js";
import type { DiscoveredTicket } from "./store.js";

export interface ThreadComment {
  body: string;
  id: string;
}

export interface TicketView {
  anchorId: string | null;
  facts: TicketFacts;
  foremanComments: ThreadComment[];
  issueId: string;
  undeliverable: string[] | null;
}

interface CommentNode {
  body: string;
  createdAt: string;
  id: string;
  parent: { id: string } | null;
  user: { id: string; name: string } | null;
}

/**
 * The comments the writer reads to judge a close, from anywhere on the ticket
 * including the Slack thread: the newest staff comments (authors in the owner
 * map) and, separately, the newest of Foreman's own, each group capped. Only
 * staff count as evidence of a change; bots, external users, reporters and
 * anyone else outside the owner map never do. Foreman's reporter updates are
 * left out.
 */
export const closingCommentsOf = (
  comments: readonly CommentNode[],
  viewerId: string,
  identifier: string
): ClosingComment[] => {
  const sorted = [...comments].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  );
  const foreman = sorted
    .filter(
      (comment) =>
        comment.user?.id === viewerId && !isReporterUpdate(identifier, comment)
    )
    .slice(-CLOSING_COMMENTS)
    .map((comment) => ({ ...comment, author: "foreman" as const }));
  const staff = sorted
    .filter(
      (comment) =>
        comment.user !== null &&
        comment.user.id !== viewerId &&
        mappedOwner(comment.user.name) !== null
    )
    .slice(-CLOSING_COMMENTS)
    .map((comment) => ({ ...comment, author: "staff" as const }));
  return [...staff, ...foreman]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(({ author, body, createdAt }) => ({ author, body, createdAt }));
};

export interface LinearPort {
  discover: (
    updatedSince: string,
    createdAfter: string,
    after: string | null
  ) => Promise<{ next: string | null; tickets: DiscoveredTicket[] }>;
  findComment: (id: string) => Promise<{ parentId: string | null } | null>;
  postUnderAnchor: (
    issueId: string,
    anchorId: string,
    body: string,
    id: string
  ) => Promise<string>;
  readOriginal: (identifier: string) => Promise<TicketFacts | null>;
  readTicket: (identifier: string) => Promise<TicketView | null>;
}

type Fetch = typeof fetch;
type Variables = NonNullable<
  Parameters<typeof callLinearGraphQL>[0]["variables"]
>;

const ASKS_SOURCE = "linear-asks-bot";
const SLACK_THREAD =
  /^https:\/\/([a-z0-9-]+)\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:[/?#]|$)/iu;
const ANCHOR_PREFIX = "Slack thread connected in ";
const DISCOVER_PAGES = 20;
const ANCHOR_LINK = /\]\((https:\/\/[^\s)]+)\)/u;
const CLOSING_COMMENTS = 5;

const TICKET_QUERY = `query ReporterTicket($id: String!) {
  viewer { id }
  issue(id: $id) {
    id
    identifier
    title
    description
    createdAt
    canceledAt
    completedAt
    state { name type }
    assignee { name }
    labels(first: 50) { nodes { name } }
    attachments(first: 50) { nodes { title url metadata } }
    parent {
      identifier
      state { type }
      attachments(first: 50) { nodes { title url } }
    }
    relations(first: 50) { nodes { type relatedIssue { identifier } } }
    comments(first: 100) {
      pageInfo { hasNextPage }
      nodes { id body createdAt parent { id } user { id name } }
    }
  }
}`;

const ORIGINAL_COMMENTS = 100;
const ORIGINAL_QUERY = `query ReporterOriginal($id: String!) {
  viewer { id }
  issue(id: $id) {
    identifier
    title
    description
    state { name type }
    assignee { name }
    labels(first: 50) { nodes { name } }
    attachments(first: 50) { nodes { title url } }
    parent { identifier state { type } attachments(first: 50) { nodes { title url } } }
    comments(first: ${ORIGINAL_COMMENTS}) {
      nodes { id body createdAt parent { id } user { id name } }
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
    nodes { identifier updatedAt parent { updatedAt } }
  }
}`;

const attachments = z.object({
  nodes: z.array(
    z.object({
      metadata: z.record(z.string(), z.unknown()).nullish(),
      title: z.string(),
      url: z.string(),
    })
  ),
});
const ticketSchema = z.object({
  issue: z
    .object({
      assignee: z.object({ name: z.string() }).nullable(),
      attachments,
      canceledAt: z.string().nullable(),
      comments: z.object({
        nodes: z.array(
          z.object({
            body: z.string(),
            createdAt: z.string(),
            id: z.string(),
            parent: z.object({ id: z.string() }).nullable(),
            user: z.object({ id: z.string(), name: z.string() }).nullable(),
          })
        ),
        pageInfo: z.object({ hasNextPage: z.boolean() }),
      }),
      completedAt: z.string().nullable(),
      createdAt: z.string(),
      description: z.string().nullable(),
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
      relations: z.object({
        nodes: z.array(
          z.object({
            relatedIssue: z.object({ identifier: z.string() }).nullable(),
            type: z.string(),
          })
        ),
      }),
      state: z.object({ name: z.string(), type: z.string() }),
      title: z.string(),
    })
    .nullable(),
  viewer: z.object({ id: z.string() }),
});
const linkNodes = z.object({
  nodes: z.array(z.object({ title: z.string(), url: z.string() })),
});
const commentNodes = z.object({
  nodes: z.array(
    z.object({
      body: z.string(),
      createdAt: z.string(),
      id: z.string(),
      parent: z.object({ id: z.string() }).nullable(),
      user: z.object({ id: z.string(), name: z.string() }).nullable(),
    })
  ),
});
const originalSchema = z.object({
  issue: z
    .object({
      assignee: z.object({ name: z.string() }).nullable(),
      attachments: linkNodes,
      comments: commentNodes,
      description: z.string().nullable(),
      identifier: z.string(),
      labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
      parent: z
        .object({
          attachments: linkNodes,
          identifier: z.string(),
          state: z.object({ type: z.string() }),
        })
        .nullable(),
      state: z.object({ name: z.string(), type: z.string() }),
      title: z.string(),
    })
    .nullable(),
  viewer: z.object({ id: z.string() }),
});

const pullUrlsOf = (nodes: readonly { url: string }[]): string[] => [
  ...new Set(
    nodes
      .map((node) => node.url.trim())
      .filter((url) => parsePullUrl(url) !== null)
  ),
];

const commentSchema = z.object({
  comment: z
    .object({ id: z.string(), parent: z.object({ id: z.string() }).nullable() })
    .nullable(),
});
const recentSchema = z.object({
  issues: z.object({
    nodes: z.array(
      z.object({
        identifier: z.string(),
        parent: z.object({ updatedAt: z.string() }).nullable(),
        updatedAt: z.string(),
      })
    ),
    pageInfo: z.object({
      endCursor: z.string().nullable(),
      hasNextPage: z.boolean(),
    }),
  }),
});
interface SlackThread {
  channel: string;
  permalink: string;
}

const parseThread = (url: string): SlackThread | null => {
  const match = SLACK_THREAD.exec(url);
  return match
    ? {
        channel: match[2] as string,
        permalink:
          `https://${match[1]}.slack.com/archives/${match[2]}/p${match[3]}${match[4]}`.toLowerCase(),
      }
    : null;
};

type Delivery =
  | { anchorId: string; channel: string | null; undeliverable: null }
  | { anchorId: string; channel: null; undeliverable: string[] };

const deliveryOf = (
  attachmentNodes: readonly {
    metadata?: Record<string, unknown> | null;
    url: string;
  }[],
  anchors: readonly { body: string; id: string }[]
): Delivery => {
  const owned = anchors.map((anchor) => {
    const link = ANCHOR_LINK.exec(anchor.body)?.[1];
    return { id: anchor.id, thread: link ? parseThread(link) : null };
  });
  const fallback = owned[0]?.id ?? "";
  const target = attachmentNodes
    .filter((node) => node.metadata?.source === ASKS_SOURCE)
    .map((node) => parseThread(node.url))
    .find((thread) => thread !== null);
  if (target) {
    const match = owned.find(
      (anchor) => anchor.thread?.permalink === target.permalink
    );
    return match
      ? { anchorId: match.id, channel: target.channel, undeliverable: null }
      : {
          anchorId: fallback,
          channel: null,
          undeliverable: [
            target.channel,
            ...owned.flatMap((anchor) => anchor.thread?.channel ?? []),
          ],
        };
  }
  const channels = new Set(owned.map((anchor) => anchor.thread?.channel));
  const [only] = channels;
  return {
    anchorId: fallback,
    channel: channels.size === 1 && only ? only : null,
    undeliverable: null,
  };
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
      const tickets: DiscoveredTicket[] = [];
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
        tickets.push(
          ...data.issues.nodes.map((node) => ({
            issue: node.identifier,
            version: Math.max(
              Date.parse(node.updatedAt),
              node.parent ? Date.parse(node.parent.updatedAt) : 0
            ),
          }))
        );
        const { endCursor, hasNextPage } = data.issues.pageInfo;
        if (!(hasNextPage && endCursor)) {
          return null;
        }
        return remaining > 1 ? page(endCursor, remaining - 1) : endCursor;
      };
      const next = await page(after, DISCOVER_PAGES);
      return { next, tickets };
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
    async readOriginal(identifier) {
      const { issue, viewer } = originalSchema.parse(
        await call(ORIGINAL_QUERY, "ReporterOriginal", { id: identifier })
      );
      return issue
        ? {
            assignee: issue.assignee?.name ?? null,
            channel: null,
            closedAt: null,
            closingComments: closingCommentsOf(
              issue.comments.nodes,
              viewer.id,
              issue.identifier
            ),
            createdAt: "",
            description: issue.description ?? "",
            duplicateOf: null,
            identifier: issue.identifier,
            labels: issue.labels.nodes.map((label) => label.name),
            parent: issue.parent
              ? {
                  identifier: issue.parent.identifier,
                  stateType: issue.parent.state.type,
                }
              : null,
            pullUrls: pullUrlsOf([
              ...issue.attachments.nodes,
              ...(issue.parent?.attachments.nodes ?? []),
            ]),
            stateName: issue.state.name,
            stateType: issue.state.type,
            title: issue.title,
          }
        : null;
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
      const delivery = deliveryOf(issue.attachments.nodes, anchors);
      const pullUrls = [
        ...issue.attachments.nodes,
        ...(issue.parent?.attachments.nodes ?? []),
      ]
        .map((node) => node.url.trim())
        .filter((url) => parsePullUrl(url) !== null);
      const closingComments = closingCommentsOf(
        comments,
        data.viewer.id,
        issue.identifier
      );
      return {
        anchorId: anchor ? delivery.anchorId : null,
        facts: {
          assignee: issue.assignee?.name ?? null,
          channel: delivery.channel,
          closedAt: issue.canceledAt ?? issue.completedAt,
          closingComments,
          createdAt: issue.createdAt,
          description: issue.description ?? "",
          duplicateOf:
            issue.relations.nodes.find(
              (relation) => relation.type === "duplicate"
            )?.relatedIssue?.identifier ?? null,
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
          title: issue.title,
        },
        foremanComments: comments
          .filter(
            (comment) =>
              anchors.some(
                (candidate) => candidate.id === comment.parent?.id
              ) && comment.user?.id === data.viewer.id
          )
          .map((comment) => ({ body: comment.body, id: comment.id })),
        issueId: issue.id,
        undeliverable: delivery.undeliverable,
      };
    },
  };
};
