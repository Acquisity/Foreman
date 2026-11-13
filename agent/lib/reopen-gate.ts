import { isAskFromTitle, slackChannelOf } from "./linear-context.js";
import { RECEIVER_ONLY_CHANNELS } from "./slack-intake.js";

/** One Linear GraphQL read with Foreman's own app token. */
export type LinearRead = <T>(
  query: string,
  queryName: string,
  variables: Record<string, string>
) => Promise<T>;

export const REOPEN_QUERY = `query RouteReopenCheck($id: String!, $state: String!) {
  issue(id: $id) {
    state { type }
    attachments(first: 50) { nodes { title url } }
    team { states(first: 5, filter: { name: { eqIgnoreCase: $state } }) { nodes { type } } }
  }
}`;

interface ReopenRead {
  issue: {
    attachments: { nodes: { title: string; url: string }[] };
    state: { type: string };
    team: { states: { nodes: { type: string }[] } };
  } | null;
}

const isClosed = (type: string) => type === "completed" || type === "canceled";

/** Whether an 'Ask from' attachment links a thread in an Asks receiver channel. */
export const isReceiverAsk = (
  attachments: readonly { title: string; url: string }[]
): boolean =>
  attachments.some(
    ({ title, url }) =>
      isAskFromTitle(title) &&
      RECEIVER_ONLY_CHANNELS.has(slackChannelOf(url) ?? "")
  );

/**
 * Refuses moving a Done or Canceled receiver ask back to an open state, so a
 * follow-up never reopens it; closed to closed still works. A failed read
 * refuses too, since the state change could not be checked.
 */
export const reopenRefusal = async (
  issue: string,
  state: string,
  linear: LinearRead
): Promise<{ code: string; reason: string } | null> => {
  let read: ReopenRead;
  try {
    read = await linear<ReopenRead>(REOPEN_QUERY, "RouteReopenCheck", {
      id: issue,
      state,
    });
  } catch {
    return {
      code: "reopen_unchecked",
      reason: `Could not read ${issue}'s current state, so the state change was not written. Call route_ticket again, or leave state out.`,
    };
  }
  const ticket = read.issue;
  if (!ticket) {
    return {
      code: "reopen_unchecked",
      reason: `No issue ${issue}, so nothing was written.`,
    };
  }
  const opens = ticket.team.states.nodes.some((node) => !isClosed(node.type));
  if (
    isClosed(ticket.state.type) &&
    opens &&
    isReceiverAsk(ticket.attachments.nodes)
  ) {
    return {
      code: "closed_reopen",
      reason: `${issue} is Done or Canceled and came from an Asks channel, so it is not reopened and nothing was written. Answer the requester and leave state out; only a move to another closed state is allowed.`,
    };
  }
  return null;
};
