import type { LinearAgentSessionEvent } from "eve/channels/linear";

// Kept in its own module so linear-context.test.ts can import it without
// pulling in @vercel/connect (channels/linear.ts wires the Connect channel).

/** Points a customer report at the same procedure the Slack intake channels load. */
export const LINEAR_TRIAGE_ROUTE = `If this issue is a customer report or support ask (it usually carries an 'Ask from' Slack link or a 'Support conversation' link) rather than an implementation request, load the triage-investigate skill before investigating; its Stage 1 hands money asks to billing-triage. When the issue has a comment starting 'Slack thread connected in', the requester is in that Slack thread: send them exactly one message with reply_to_requester, your answer or your questions when you need more from them, and never the investigation itself. When a reply under that comment mentions you, or you are told someone replied in Slack, the requester answered in Slack and this is a follow-up, not a new ticket: read the ticket's Triage or Billing investigation document and their reply, and pass your answer to reply_to_requester. It asks Jev whether their reply needs one: when it returns posted false with an outcome, their reply needed nothing from you: post nothing anywhere and end the session with one short line. A result with an error is a failed delivery, not a decision: fix what it names or say in the document that the reply was not sent. Never comment under the Slack thread comment any other way, since everything there reaches the requester. On a follow-up, post no new ticket comment and update the document only if a finding changes. Do not restart the investigation. If the verdict was waiting on this answer, finish from there: the decision tool, the document, one route_ticket call. If their reply corrects your conclusion or changes the outcome they want, call classify_ask, decide_triage, or decide_billing again with the new evidence and apply its route.`;

const ASK_FROM = /^Ask from (.{1,100})$/;

/**
 * The intake requester named by an issue's 'Ask from <name>' attachment. The
 * Asks receiver opens intake sessions with one person's key, so neither the
 * session opener nor a prompt's author is the requester there (ENG-14588).
 */
export const askFromName = (titles: readonly string[]): string | null => {
  for (const title of titles) {
    const name = ASK_FROM.exec(title.trim())?.[1]?.trim();
    if (name) {
      return name;
    }
  }
  return null;
};

/**
 * @param route - Replaces the triage line for a session whose issue has its
 *   own playbook (widget feedback); omitted, the session gets today's triage.
 */
export function buildLinearContext(
  event: LinearAgentSessionEvent,
  askFrom: string | null = null,
  route: string = LINEAR_TRIAGE_ROUTE
): string[] | null {
  if (event.action !== "created" && event.action !== "prompted") {
    return null;
  }
  const context: string[] = [route];
  // Naming the opener alongside the requester was not enough: the model
  // still greeted the opener (ENG-14406, ENG-14588), so it is left out here.
  if (askFrom) {
    context.push(
      `The requester is ${askFrom}, from the ticket's 'Ask from' link. Address every reply_to_requester message to ${askFrom}, not to whoever opened this session or wrote last in the Slack thread.`
    );
    return context;
  }
  const requester = event.agentActivity?.user ?? event.agentSession.creator;
  const requesterName = requester?.displayName ?? requester?.name;
  if (requesterName) {
    context.push(
      `This Linear session was opened by ${requesterName}. When the ticket has an 'Ask from <name>' link, that person is the requester: address every reply_to_requester message to them, never to ${requesterName} or whoever wrote last in the Slack thread. Otherwise ${requesterName} is the requester.`
    );
  }
  return context;
}
