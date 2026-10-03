import {
  callLinearGraphQL,
  type LinearChannelCredentials,
} from "eve/channels/linear";
import {
  decideFollowUp,
  type FollowUpInput,
  type FollowUpOutcome,
  RELAY_HEADER,
  SLACK_PROMPT,
} from "./jev-decisions.js";
import { askFromName } from "./linear-context.js";
import { WIDGET_FEEDBACK_PROJECT_ID } from "./widget-feedback.js";

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
// The Acquisity support inbox roots its notes the same way, in "Support
// conversation connected in …", and imports Foreman's reply as a team note.
const ANCHOR_PATTERN = /^(?:Slack thread|Support conversation) connected in /u;

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
  const byTime = (a: ThreadComment, b: ThreadComment) =>
    a.createdAt.localeCompare(b.createdAt);
  const anchors = comments
    .filter((c) => c.parentId === null && ANCHOR_PATTERN.test(c.body.trim()))
    .sort(byTime);
  const lastIn = (anchorId: string) =>
    comments
      .filter((c) => c.parentId === anchorId)
      .sort(byTime)
      .at(-1);
  // One issue can carry a Slack thread and several support conversations.
  // The reply belongs to the one whose newest message is still unanswered;
  // with none waiting, the earliest anchor is the intake's own.
  const waiting = anchors
    .map((a) => ({ anchor: a, last: lastIn(a.id) }))
    .filter(({ last }) => last && last.userId !== foremanUserId)
    .sort((a, b) => byTime(a.last as ThreadComment, b.last as ThreadComment))
    .at(-1)?.anchor;
  const anchor = waiting ?? anchors.at(0);
  if (!anchor) {
    return {
      error:
        "This issue has no requester thread (no 'Slack thread connected in' or 'Support conversation connected in' comment), so there is nobody to reply to there.",
      ok: false,
    };
  }
  const thread = comments.filter((c) => c.parentId === anchor.id).sort(byTime);
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
  viewer { id displayName url }
  issue(id: $id) {
    id
    project { id }
    comments(first: 100) {
      pageInfo { hasNextPage }
      nodes { id body createdAt parent { id } user { id } }
    }
  }
}`;

const ASK_FROM_QUERY = `query AskFrom($id: String!) {
  issue(id: $id) { attachments(first: 50) { nodes { title } } }
}`;

/** The intake requester from the issue's 'Ask from <name>' attachment, or null. */
export async function readAskFrom(
  issue: string,
  credentials: LinearChannelCredentials
): Promise<string | null> {
  const result = await callLinearGraphQL<{
    issue: { attachments: { nodes: { title: string }[] } } | null;
  }>({
    credentials,
    query: ASK_FROM_QUERY,
    queryName: "AskFrom",
    variables: { id: issue },
  });
  return askFromName(
    result.issue?.attachments.nodes.map((node) => node.title) ?? []
  );
}

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
    project: { id: string } | null;
  } | null;
  viewer: ForemanUser;
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

/** Foreman's own Linear app user, as the thread read's viewer. */
export interface ForemanUser {
  displayName: string;
  id: string;
  url: string;
}

async function readThread(
  issue: string,
  credentials: LinearChannelCredentials
): Promise<{
  comments: ThreadComment[];
  foreman: ForemanUser;
  issueId: string;
  plan: ReplyPlan;
  widgetFeedback: boolean;
}> {
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
  const comments = thread.issue.comments.nodes.map((c) => ({
    body: c.body,
    createdAt: c.createdAt,
    id: c.id,
    parentId: c.parent?.id ?? null,
    userId: c.user?.id ?? null,
  }));
  return {
    comments,
    foreman: thread.viewer,
    issueId: thread.issue.id,
    plan: planReply(comments, thread.viewer.id),
    widgetFeedback: thread.issue.project?.id === WIDGET_FEEDBACK_PROJECT_ID,
  };
}

/**
 * What a relayed Slack reply needs from Foreman, whether it opened a session
 * or was prompted into the ticket's existing one, decided
 * before the model runs so a skip costs one read and one Jev call instead of
 * a full turn. A person writing to Foreman directly is judged only on a chat
 * widget ticket (ENG-14674); on every other ticket that returns null.
 */
export async function relayedFollowUpOutcome(
  issue: string,
  trigger: { commentId: string; prompted: boolean },
  credentials: LinearChannelCredentials,
  signal?: AbortSignal
): Promise<FollowUpOutcome | null> {
  const { comments, foreman, plan, widgetFeedback } = await readThread(
    issue,
    credentials
  );
  const followUp =
    (trigger.prompted
      ? promptedFollowUp(comments, plan, trigger.commentId)
      : relayedFollowUp(comments, plan, trigger.commentId)) ??
    (widgetFeedback ? directFollowUp(comments, foreman, trigger) : null);
  if (followUp === null) {
    return null;
  }
  const outcome = await decideFollowUp(followUp, { signal });
  // Before Foreman has spoken there is nothing a reply could leave settled,
  // so only a status move is acted on; anything else runs as before.
  return followUp.lastReply === "" && outcome === "skip" ? null : outcome;
}

/**
 * The follow-up to judge when a relayed Slack reply opened the session.
 * Before Foreman has replied, lastReply is empty and every reply under the
 * anchor is judged, so a close-out that lands first is still seen.
 */
export function relayedFollowUp(
  comments: readonly ThreadComment[],
  plan: ReplyPlan,
  commentId: string
): FollowUpInput | null {
  if (!plan.ok) {
    return null;
  }
  const followUp = plan.followUp ?? {
    lastReply: "",
    replies: comments
      .filter((c) => c.parentId === plan.anchorId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((c) => c.body),
  };
  const said = (body: string) => body.replace(RELAY_HEADER, "").trim();
  const trigger = comments.find((c) => c.id === commentId);
  // The receiver writes the copy under the anchor first; until it is there,
  // the thread does not include this reply and must not be judged without it.
  return trigger &&
    RELAY_HEADER.test(trigger.body) &&
    followUp.replies.some((r) => said(r) === said(trigger.body))
    ? followUp
    : null;
}

/**
 * The follow-up to judge when the receiver prompted the ticket's Foreman
 * session. Replies that arrived before the session's previous prompt were
 * already judged or handled, so they go to Jev as context only; judging them
 * again let one old question wake every later reply in a burst (ENG-14396).
 */
export function promptedFollowUp(
  comments: readonly ThreadComment[],
  plan: ReplyPlan,
  promptId: string
): FollowUpInput | null {
  const prompt = comments.find((c) => c.id === promptId);
  if (!(plan.ok && prompt && SLACK_PROMPT.test(prompt.body.trim()))) {
    return null;
  }
  const handledAt = comments
    .filter(
      (c) =>
        c.parentId === prompt.parentId &&
        c.id !== prompt.id &&
        c.createdAt < prompt.createdAt &&
        SLACK_PROMPT.test(c.body.trim())
    )
    .map((c) => c.createdAt)
    .sort()
    .at(-1);
  const thread = comments
    .filter((c) => c.parentId === plan.anchorId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const since = plan.followUp
    ? thread.slice(thread.length - plan.followUp.replies.length)
    : thread;
  // A reply after this prompt belongs to the next prompt's judgment.
  const eligible = since.filter((c) => c.createdAt <= prompt.createdAt);
  const earlier = eligible.filter((c) => handledAt && c.createdAt <= handledAt);
  const fresh = eligible.filter((c) => !earlier.includes(c));
  if (fresh.length === 0) {
    return null;
  }
  return {
    lastReply: plan.followUp?.lastReply ?? "",
    replies: fresh.map((c) => c.body),
    ...(earlier.length > 0 ? { earlier: earlier.map((c) => c.body) } : {}),
  };
}

/**
 * The follow-up to judge when a person wrote to Foreman directly on a chat
 * widget ticket: a reply in a session thread, or a comment that mentions it.
 * Only that one comment is judged, against the last thing Foreman said on the
 * ticket. Delegation opens its session on Linear's own thread comment, which
 * carries no mention and is never judged, and neither is a bare mention: both
 * ask for the diagnosis itself.
 */
export function directFollowUp(
  comments: readonly ThreadComment[],
  foreman: ForemanUser,
  trigger: { commentId: string; prompted: boolean }
): FollowUpInput | null {
  const comment = comments.find((c) => c.id === trigger.commentId);
  if (
    !comment ||
    comment.userId === foreman.id ||
    // A relayed reply or its prompt belongs to the requester-thread gate.
    RELAY_HEADER.test(comment.body) ||
    SLACK_PROMPT.test(comment.body.trim())
  ) {
    return null;
  }
  const text = comment.body
    .replaceAll(`@${foreman.displayName}`, "@Foreman")
    .replaceAll(foreman.url, "@Foreman")
    .trim();
  if (
    !(trigger.prompted || text.includes("@Foreman")) ||
    text.replaceAll("@Foreman", "").trim() === ""
  ) {
    return null;
  }
  const lastReply = comments
    .filter((c) => c.userId === foreman.id && c.createdAt < comment.createdAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  return {
    lastReply: lastReply?.body ?? "",
    replies: [text],
  };
}

export async function replyToRequester(
  issue: string,
  message: string,
  accessToken: string,
  signal?: AbortSignal
): Promise<ReplyResult> {
  const credentials = { accessToken };
  const { issueId, plan } = await readThread(issue, credentials);
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
        issueId,
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
