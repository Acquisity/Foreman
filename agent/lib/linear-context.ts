import type { LinearAgentSessionEvent } from "eve/channels/linear";

// Kept in its own module so linear-context.test.ts can import it without
// pulling in @vercel/connect (channels/linear.ts wires the Connect channel).

/** Points a customer report at the same procedure the Slack intake channels load. */
export const LINEAR_TRIAGE_ROUTE = `If this issue is a customer report or support ask (it usually carries an 'Ask from' Slack link or a 'Support conversation' link) rather than an implementation request, load the triage-investigate skill before investigating; its Stage 1 hands money asks to billing-triage. When the issue has a comment starting 'Slack thread connected in', replies to that comment reach the requester in Slack: post your clarifying questions and your one final requester-facing answer there with the Linear connection's save_comment and that comment's id as parentId, and never the investigation itself.`;

export function buildLinearContext(
  event: LinearAgentSessionEvent
): string[] | null {
  if (event.action !== "created" && event.action !== "prompted") {
    return null;
  }
  const requester = event.agentActivity?.user ?? event.agentSession.creator;
  const context: string[] = [LINEAR_TRIAGE_ROUTE];
  const requesterName = requester?.displayName ?? requester?.name;
  if (requesterName) {
    context.push(`The requesting user is ${requesterName}.`);
  }
  return context;
}
