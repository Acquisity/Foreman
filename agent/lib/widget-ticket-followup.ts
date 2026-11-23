import { createHash } from "node:crypto";
import { getToken as getConnectToken } from "@vercel/connect";
import { callLinearGraphQL } from "eve/channels/linear";
import { FIXY_LINEAR_USER_ID } from "./fixy-handoff.js";

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

const COMMENT = `mutation WidgetFollowUp($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;

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

/**
 * A follow-up that needs the team again goes on the conversation's existing
 * ticket: one comment with what the customer wrote now (a fixed id per run),
 * and a Done ticket moves back to Todo so its owner picks it up. Throws when
 * either write fails, so the caller never tells the customer it was passed on.
 */
export async function followUpOnTicket(
  ticket: { identifier: string; stateType: string },
  summary: string,
  runId: string,
  signal: AbortSignal,
  request: typeof linearAppRequest = linearAppRequest
): Promise<void> {
  const body = [
    "The customer followed up in the support chat:",
    summary
      .slice(0, 4000)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
  ].join("\n\n");
  const created = await request<{ commentCreate: { success: boolean } }>(
    "WidgetFollowUp",
    COMMENT,
    {
      input: {
        body,
        id: commentIdFor(`widget-follow-up:${runId}`),
        issueId: ticket.identifier,
      },
    },
    signal
  );
  if (!created.commentCreate.success) {
    throw new Error("Linear did not create the comment.");
  }
  if (ticket.stateType !== "completed") {
    return;
  }
  const { issue } = await request<{
    issue: {
      team: {
        states: { nodes: { id: string; name: string; position: number }[] };
      };
    } | null;
  }>("WidgetTicketStates", OPEN_STATES, { id: ticket.identifier }, signal);
  const state = reopenState(issue?.team.states.nodes ?? []);
  if (!state) {
    throw new Error("The ticket's team has no open state.");
  }
  const updated = await request<{ issueUpdate: { success: boolean } }>(
    "WidgetTicketReopen",
    REOPEN,
    { id: ticket.identifier, stateId: state.id },
    signal
  );
  if (!updated.issueUpdate.success) {
    throw new Error("Linear did not reopen the ticket.");
  }
}

const TICKET_COMMENTS = `query WidgetTicketComments($id: String!) {
  issue(id: $id) {
    state { type }
    comments(first: 100) { nodes { body updatedAt parent { id } user { id } } }
  }
}`;

const NOTE_MAX_CHARS = 1500;
const URL = /\bhttps?:\/\/\S+/giu;
const TICKET_ID = /\b[A-Z]{2,10}-\d{1,7}\b/gu;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;

/** A team-only comment with links, ticket numbers and record ids taken out before a writer reads it. */
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

/**
 * The server's note on the conversation's ticket for a follow-up: where it
 * stands and Fixy's closing comment, which Fixy keeps current in place. Null
 * when it cannot be read.
 */
export async function ticketNote(
  identifier: string,
  signal: AbortSignal,
  request: typeof linearAppRequest = linearAppRequest
): Promise<string | null> {
  const { issue } = await request<{
    issue: {
      comments: {
        nodes: {
          body: string;
          parent: { id: string } | null;
          updatedAt: string;
          user: { id: string } | null;
        }[];
      };
      state: { type: string };
    } | null;
  }>("WidgetTicketComments", TICKET_COMMENTS, { id: identifier }, signal);
  if (!issue) {
    return null;
  }
  const [closing] = issue.comments.nodes
    .filter(
      (comment) => !comment.parent && comment.user?.id === FIXY_LINEAR_USER_ID
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const note = closing ? scrubbed(closing.body) : "";
  return [
    `This conversation already has a ticket with the support team, and it is ${STATUS[issue.state.type] ?? "with the team, not started yet"}.`,
    note
      ? `The team's closing note on it, written for staff and never to be quoted: """${note}""". Use it to answer a follow-up about what the team found or did, in plain customer words.`
      : "The team has not written its answer on it yet; their answer will come here in this chat.",
    "Never mention the ticket itself, its status names, links, code or people.",
  ].join(" ");
}
