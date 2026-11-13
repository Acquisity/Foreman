import { FIXY_LABEL } from "./fixy-handoff.js";
import type { RouteTicketInput } from "./linear-api.js";
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
    attachments(first: 50) { nodes { title url } pageInfo { hasNextPage } }
    team { states(first: 5, filter: { name: { eqIgnoreCase: $state } }) { nodes { type } } }
  }
}`;

interface ReopenRead {
  issue: {
    attachments: {
      nodes: { title: string; url: string }[];
      pageInfo: { hasNextPage: boolean };
    };
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
  // Only a reopen needs the Asks check; closed to closed always goes through.
  if (!(isClosed(ticket.state.type) && opens)) {
    return null;
  }
  if (isReceiverAsk(ticket.attachments.nodes)) {
    return {
      code: "closed_reopen",
      reason: `${issue} is Done or Canceled and came from an Asks channel, so it is not reopened and nothing was written. Answer the requester and leave state out; only a move to another closed state is allowed.`,
    };
  }
  if (ticket.attachments.pageInfo.hasNextPage) {
    return {
      code: "reopen_unchecked",
      reason: `Could not check all of ${issue}'s attachments, so the state change was not written. Leave state out.`,
    };
  }
  return null;
};

/** A routing gate that refused before any write; `code` is safe to log. */
export class RouteGateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Fixy lifecycle labels and ownership are not ordinary routing decisions. */
export const assertFixyRouting = (
  input: RouteTicketInput,
  labels: readonly { name: string }[]
): void => {
  if (
    [...(input.addLabels ?? []), ...(input.removeLabels ?? [])].some(
      (label) => label.trim().toLowerCase() === FIXY_LABEL
    )
  ) {
    throw new RouteGateError(
      "fixy_label",
      "Only hand_to_fixy adds the fixy label, and only a person removes it. Nothing was written."
    );
  }
  if (
    labels.some((label) => label.name === FIXY_LABEL) &&
    (input.state !== undefined ||
      input.assignee !== undefined ||
      input.inheritAssigneeFrom !== undefined ||
      input.releaseDeveloper)
  ) {
    throw new RouteGateError(
      "fixy_owned",
      `${input.issue} carries the ${FIXY_LABEL} label, so Fixy owns its status and assignee and nothing was written. Leave state and assignee out; labels, priority and project still apply. To give Fixy new facts, call hand_to_fixy again.`
    );
  }
};
