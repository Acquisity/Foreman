import type { LinearAgentSessionEvent } from "eve/channels/linear";

// Kept in its own module so linear-context.test.ts can import it without
// pulling in @vercel/connect (channels/linear.ts wires the Connect channel).
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
