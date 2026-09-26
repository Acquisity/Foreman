import type { LinearAgentSessionEvent } from "eve/channels/linear";

// Kept in its own module so linear-context.test.ts can import it without
// pulling in @vercel/connect (channels/linear.ts wires the Connect channel).

/** Points a customer report at the same procedure the Slack intake channels load. */
export const LINEAR_TRIAGE_ROUTE = `If this issue is a customer report or support ask (it usually carries an 'Ask from' Slack link or a 'Support conversation' link) rather than an implementation request, load the triage-investigate skill before investigating; its Stage 1 hands money asks to billing-triage. When the issue has a comment starting 'Slack thread connected in', the requester is in that Slack thread: send them exactly one message with reply_to_requester, your answer or your questions when you need more from them, and never the investigation itself. When a reply under that comment mentions you, the requester answered in Slack and this is a follow-up, not a new ticket: read the ticket's Triage or Billing investigation document and their reply, and pass your answer to reply_to_requester. It asks Jev whether their reply needs one: when it returns posted false with an outcome, post nothing and follow its reason, which ends the turn or records their context in the document. A result with an error is a failed delivery, not a decision: fix what it names or say in the document that the reply was not sent. Never comment under the Slack thread comment any other way, since everything there reaches the requester. Apart from a note outcome, update the document only if a finding changes. Do not restart the investigation. If the verdict was waiting on this answer, finish from there: the decision tool, the document, one route_ticket call. If their reply corrects your conclusion or changes the outcome they want, call classify_ask, decide_triage, or decide_billing again with the new evidence and apply its route.`;

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
