import { createHash } from "node:crypto";
import { getToken as getConnectToken } from "@vercel/connect";
import { callLinearGraphQL } from "eve/channels/linear";
import { FIXY_LINEAR_USER_ID, FIXY_RUN_FINISHED } from "./fixy-handoff.js";

const LINEAR_MS = 15_000;

/** One Linear request with Foreman's own Linear app token: the widget toolkit's only Linear write is filing the ticket. */
export async function linearAppRequest<T>(
  queryName: string,
  query: string,
  variables: Parameters<typeof callLinearGraphQL>[0]["variables"],
  signal: AbortSignal
): Promise<T> {
  const token = await getConnectToken(
    process.env.LINEAR_CONNECTOR ?? "linear/foreman-agent",
    { scopes: ["read", "write", "comments:create"], subject: { type: "app" } }
  );
  const timed = AbortSignal.any([signal, AbortSignal.timeout(LINEAR_MS)]);
  return await callLinearGraphQL<T>({
    api: { fetch: (url, init) => fetch(url, { ...init, signal: timed }) },
    credentials: { accessToken: token },
    query,
    queryName,
    variables,
  });
}

/** A fixed comment id derived from a seed, so Linear refuses a second comment for the same request. */
export const commentIdFor = (seed: string) => {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${"89ab"[Number.parseInt(hex[16], 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const COMMENT = `mutation WidgetTicketComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;

/** One comment with Foreman's own Linear app token, under a fixed id. */
export async function commentOnTicket(
  identifier: string,
  body: string,
  id: string,
  signal: AbortSignal,
  request: typeof linearAppRequest = linearAppRequest
): Promise<void> {
  const created = await request<{ commentCreate: { success: boolean } }>(
    "WidgetTicketComment",
    COMMENT,
    { input: { body, id, issueId: identifier } },
    signal
  );
  if (!created.commentCreate.success) {
    throw new Error("Linear did not create the comment.");
  }
}

const DESCRIPTION = `query WidgetTicketDescription($id: String!) {
  issue(id: $id) { description }
}`;

/**
 * Whether a search hit is this conversation's own ticket: its description
 * carries the server-written scope block for this workspace and conversation.
 * A ticket that only mentions the conversation id elsewhere is not.
 */
export async function ownsConversation(
  identifier: string,
  scope: { conversationId: string; organizationId: string },
  signal: AbortSignal,
  request: typeof linearAppRequest = linearAppRequest
): Promise<boolean> {
  const { issue } = await request<{
    issue: { description: string | null } | null;
  }>("WidgetTicketDescription", DESCRIPTION, { id: identifier }, signal);
  const description = issue?.description ?? "";
  return (
    description.includes("## Verified scope") &&
    description.includes(
      `- Organization ID: ${scope.organizationId}\n- Support conversation: ${scope.conversationId}`
    )
  );
}

const OPEN_STATES = `query WidgetTicketStates($id: String!) {
  issue(id: $id) { team { states(filter: { type: { eq: "unstarted" } }) { nodes { id name position } } } }
}`;

const REOPEN = `mutation WidgetTicketReopen($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success }
}`;

/** The state a reopened ticket moves to: Todo, else the team's first not-started state. */
const reopenState = (
  states: { id: string; name: string; position: number }[]
) =>
  states.find((state) => state.name === "Todo") ??
  [...states].sort((a, b) => a.position - b.position)[0];

async function reopen(
  identifier: string,
  signal: AbortSignal,
  request: typeof linearAppRequest
) {
  const { issue } = await request<{
    issue: {
      team: {
        states: { nodes: { id: string; name: string; position: number }[] };
      };
    } | null;
  }>("WidgetTicketStates", OPEN_STATES, { id: identifier }, signal);
  const state = reopenState(issue?.team.states.nodes ?? []);
  if (!state) {
    throw new Error("The ticket's team has no open state.");
  }
  const updated = await request<{ issueUpdate: { success: boolean } }>(
    "WidgetTicketReopen",
    REOPEN,
    { id: identifier, stateId: state.id },
    signal
  );
  if (!updated.issueUpdate.success) {
    throw new Error("Linear did not reopen the ticket.");
  }
}

/**
 * A turn that needs the team again goes on the conversation's existing
 * ticket: a Done ticket moves back to Todo first, then one comment (a fixed
 * id per run) wakes its owner. Reopening first means a retry after a failed
 * comment finds the ticket open and only comments. Throws when either write
 * fails, so the caller never tells the customer it was passed on.
 */
export async function followUpOnTicket(
  ticket: { identifier: string; stateType: string },
  summary: string,
  runId: string,
  signal: AbortSignal,
  request: typeof linearAppRequest = linearAppRequest
): Promise<void> {
  if (ticket.stateType === "completed") {
    await reopen(ticket.identifier, signal, request);
  }
  const body = [
    "Foreman passed this conversation to the team again from the support chat:",
    summary
      .slice(0, 4000)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
  ].join("\n\n");
  await commentOnTicket(
    ticket.identifier,
    body,
    commentIdFor(`widget-follow-up:${runId}`),
    signal,
    request
  );
}

const FIXY_COMMENTS = `query WidgetTicketComments($id: String!, $fixy: ID!) {
  issue(id: $id) {
    state { type }
    comments(first: 50, orderBy: updatedAt, filter: { user: { id: { eq: $fixy } } }) {
      nodes { body parent { id } }
    }
  }
}`;

const NOTE_MAX_CHARS = 1500;
const URL = /\bhttps?:\/\/\S+/giu;
const TICKET_ID = /\b(?:ENG|AIAA|SEL|SAN)-\d{1,7}\b/gu;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;

/** A team-only comment with links, ticket numbers and record ids taken out. */
const scrubbed = (text: string) =>
  text
    .replace(URL, "")
    .replace(TICKET_ID, "")
    .replace(UUID, "")
    .slice(0, NOTE_MAX_CHARS)
    .trim();

const STATUS: Record<string, string> = {
  completed: "done",
  started: "being worked on",
};

/** The server's notes on the conversation's ticket for a follow-up. */
export interface TicketNote {
  /** The status and Fixy's closing comment, for the gated investigator. */
  forInvestigator: string;
  /** Code-written status only, for the ungated front-door writers. */
  forWriters: string;
}

/**
 * Where the conversation's ticket stands and Fixy's closing comment, which
 * Fixy keeps current in place: its newest top-level comment that is not the
 * run-finished note (Linear returns `orderBy: updatedAt` newest first). Only
 * the status, written here, reaches the front door; the closing comment goes
 * only to the investigator, whose reply passes the egress gate. Null when
 * the ticket cannot be read.
 */
export async function ticketNote(
  identifier: string,
  signal: AbortSignal,
  request: typeof linearAppRequest = linearAppRequest
): Promise<TicketNote | null> {
  const { issue } = await request<{
    issue: {
      comments: { nodes: { body: string; parent: { id: string } | null }[] };
      state: { type: string };
    } | null;
  }>(
    "WidgetTicketComments",
    FIXY_COMMENTS,
    { fixy: FIXY_LINEAR_USER_ID, id: identifier },
    signal
  );
  if (!issue) {
    return null;
  }
  const closing = issue.comments.nodes.find(
    (comment) => !comment.parent && comment.body.trim() !== FIXY_RUN_FINISHED
  );
  const note = closing ? scrubbed(closing.body) : "";
  const status = `This conversation already has a ticket with the support team, and it is ${STATUS[issue.state.type] ?? "with the team, not started yet"}.`;
  const unanswered =
    "The team has not posted its answer on it yet; it will come here in this chat.";
  const never =
    "Never mention the ticket itself, its status names, links, code or people.";
  return {
    forInvestigator: [
      status,
      note
        ? `The team's closing note on it, written for staff and never to be quoted: """${note}""". Use it to answer a follow-up about what the team found or did, in plain customer words.`
        : unanswered,
      never,
    ].join(" "),
    forWriters: [status, ...(note ? [] : [unanswered]), never].join(" "),
  };
}
