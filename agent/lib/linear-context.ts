import type { LinearAgentSessionEvent } from "eve/channels/linear";

/**
 * Builds the dispatch context for a Linear Agent Session event, or null when
 * the event should not dispatch.
 *
 * @remarks
 * Keeps the default created/prompted dispatch: any other action returns null.
 * The requester's name is added as context when Linear provides it, for
 * attribution in progress notes and reports. `created` and `prompted` add only
 * requester attribution and no factory instruction; Linear-assigned sessions
 * stay general by default.
 */
export function buildLinearContext(
  event: LinearAgentSessionEvent
): string[] | null {
  if (event.action !== "created" && event.action !== "prompted") {
    return null;
  }
  const requester = event.agentActivity?.user ?? event.agentSession.creator;
  const context: string[] = [];
  const requesterName = requester?.displayName ?? requester?.name;
  if (requesterName) {
    context.push(`The requesting user is ${requesterName}.`);
  }
  return context;
}
