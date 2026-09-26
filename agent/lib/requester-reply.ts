import { callLinearGraphQL } from "eve/channels/linear";
import {
  decideFollowUp,
  type FollowUpInput,
  type FollowUpOutcome,
} from "./jev-decisions.js";

/**
 * Replies to the requester in their Slack thread, as Foreman.
 *
 * @remarks
 * The Asks receiver roots every intake ticket's Slack conversation in one
 * anchor comment ("Slack thread connected in …") and forwards replies under
 * it to the thread, named after the comment's author. Posting with Foreman's
 * own Linear app token makes that author Acquisity Foreman rather than the
 * person whose key backs the shared Linear connection.
 *
 * One reply per requester message: when Foreman already spoke last under the
 * anchor, a second post is refused, so a late result cannot add a recap. A
 * new requester reply opens the next one only when Jev says it needs an
 * answer: every Slack reply wakes Foreman, and a bare mention, a thanks, or a
 * remark that asks nothing must not earn another message in the thread.
 */
const ANCHOR_PATTERN = /^Slack thread connected in /u;

export interface ThreadComment {
  body: string;
  createdAt: string;
  id: string;
  parentId: string | null;
  userId: string | null;
}

export type ReplyPlan =
  | { anchorId: string; followUp: FollowUpInput | null; ok: true }
  | { error: string; ok: false };

export function planReply(
  comments: readonly ThreadComment[],
  foremanUserId: string
): ReplyPlan {
  // The receiver writes the anchor top-level at intake, before anyone else
  // can comment, so the earliest top-level match is the real one.
  const anchor = comments
    .filter((c) => c.parentId === null && ANCHOR_PATTERN.test(c.body.trim()))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(0);
  if (!anchor) {
    return {
      error:
        "This issue has no Slack thread (no 'Slack thread connected in' comment), so there is nobody to reply to there.",
      ok: false,
    };
  }
  const thread = comments
    .filter((c) => c.parentId === anchor.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (thread.at(-1)?.userId === foremanUserId) {
    return {
      error:
        "Foreman already replied and the requester has not answered since. Do not post again; put anything new in the investigation document.",
      ok: false,
    };
  }
  const lastReply = thread.map((c) => c.userId).lastIndexOf(foremanUserId);
  const followUp =
    lastReply === -1
      ? null
      : {
          lastReply: thread[lastReply]?.body ?? "",
          replies: thread.slice(lastReply + 1).map((c) => c.body),
        };
  return { anchorId: anchor.id, followUp, ok: true };
}

/** What the tool tells Foreman when Jev says a follow-up needs no message. */
const SKIP_REASON =
  "Their reply needs nothing from Foreman. Post nothing: no Slack reply, no ticket comment, no document change. End the session with one short line.";

/** Jev down or slow: answering a person beats leaving them unanswered. */
async function followUpOutcome(
  followUp: FollowUpInput,
  signal?: AbortSignal
): Promise<FollowUpOutcome> {
  try {
    return await decideFollowUp(followUp, { signal });
  } catch {
    signal?.throwIfAborted();
    return "respond";
  }
}

const THREAD_QUERY = `query RequesterThread($id: String!) {
  viewer { id }
  issue(id: $id) {
    id
    comments(first: 100) {
      pageInfo { hasNextPage }
      nodes { id body createdAt parent { id } user { id } }
    }
  }
}`;

const REPLY_MUTATION = `mutation RequesterReply($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id url } }
}`;

interface ThreadResponse {
  issue: {
    comments: {
      pageInfo: { hasNextPage: boolean };
      nodes: {
        body: string;
        createdAt: string;
        id: string;
        parent: { id: string } | null;
        user: { id: string } | null;
      }[];
    };
    id: string;
  } | null;
  viewer: { id: string };
}

interface ReplyResponse {
  commentCreate: {
    comment: { id: string; url: string } | null;
    success: boolean;
  };
}

export type ReplyResult =
  | { commentId: string; posted: true; url: string }
  | {
      outcome: "skip";
      posted: false;
      reason: string;
    };

export async function replyToRequester(
  issue: string,
  message: string,
  accessToken: string,
  signal?: AbortSignal
): Promise<ReplyResult> {
  const credentials = { accessToken };
  const thread = await callLinearGraphQL<ThreadResponse>({
    credentials,
    query: THREAD_QUERY,
    queryName: "RequesterThread",
    variables: { id: issue },
  });
  if (!thread.issue) {
    throw new Error(`Issue ${issue} was not found.`);
  }
  // One page is the whole history for an intake ticket; past it the latest
  // reply may be missing, so refuse rather than risk a second message.
  if (thread.issue.comments.pageInfo.hasNextPage) {
    throw new Error(
      `${issue} has more than 100 comments, so the thread state cannot be checked; reply in Slack by hand.`
    );
  }
  const plan = planReply(
    thread.issue.comments.nodes.map((c) => ({
      body: c.body,
      createdAt: c.createdAt,
      id: c.id,
      parentId: c.parent?.id ?? null,
      userId: c.user?.id ?? null,
    })),
    thread.viewer.id
  );
  if (!plan.ok) {
    throw new Error(plan.error);
  }
  if (plan.followUp) {
    const outcome = await followUpOutcome(plan.followUp, signal);
    if (outcome === "skip") {
      return { outcome, posted: false, reason: SKIP_REASON };
    }
  }
  const created = await callLinearGraphQL<ReplyResponse>({
    credentials,
    query: REPLY_MUTATION,
    queryName: "RequesterReply",
    variables: {
      input: {
        body: message,
        issueId: thread.issue.id,
        parentId: plan.anchorId,
      },
    },
  });
  const { comment, success } = created.commentCreate;
  if (!(success && comment)) {
    throw new Error("Linear did not create the reply.");
  }
  return { commentId: comment.id, posted: true, url: comment.url };
}
