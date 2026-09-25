import { callLinearGraphQL } from "eve/channels/linear";

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
 * new requester reply opens the next one.
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
  | { anchorId: string; ok: true }
  | { error: string; ok: false };

export function planReply(
  comments: readonly ThreadComment[],
  foremanUserId: string
): ReplyPlan {
  const anchor = comments.find((c) => ANCHOR_PATTERN.test(c.body.trim()));
  if (!anchor) {
    return {
      error:
        "This issue has no Slack thread (no 'Slack thread connected in' comment), so there is nobody to reply to there.",
      ok: false,
    };
  }
  const last = comments
    .filter((c) => c.parentId === anchor.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  if (last?.userId === foremanUserId) {
    return {
      error:
        "Foreman already replied and the requester has not answered since. Do not post again; put anything new in the investigation document.",
      ok: false,
    };
  }
  return { anchorId: anchor.id, ok: true };
}

const THREAD_QUERY = `query RequesterThread($id: String!) {
  viewer { id }
  issue(id: $id) {
    id
    comments(first: 100) {
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

export async function replyToRequester(
  issue: string,
  message: string,
  accessToken: string
): Promise<{ commentId: string; url: string }> {
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
  return { commentId: comment.id, url: comment.url };
}
