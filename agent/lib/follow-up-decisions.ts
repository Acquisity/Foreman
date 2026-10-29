import {
  askJev,
  choiceOf,
  type JevOptions,
  type JevQuestion,
  probabilityOf,
} from "./jev.js";
import type { Answers } from "./jev-decisions.js";
import { BARS } from "./triage-bars.js";

/** A new fact counts only when said to Foreman or to no one (ENG-16842); ENG-15578 had let it override teammate talk. */
export const FOLLOW_UP_OUTCOMES = {
  respond:
    "speaks to Foreman (mentions @Foreman, or comes right after lastReply and follows on from it, or is addressed to no one without continuing an exchange between people) and asks Foreman something, corrects or doubts lastReply (for example, says they may have made a mistake), gives Foreman a new fact or evidence about the issue, including the fact lastReply said would reopen it, approves or withdraws the ask, or changes the outcome they want",
  skip: "anything else: people in the thread talking to each other, even when what they say is new about the issue (a reply that mentions only @teammate, even one that disputes lastReply or brings evidence, an answer or follow-up to a teammate's message, a question to a teammate that is still open, a hand-off, a decision people just made together), context that adds nothing new about the issue, an acknowledgement, thanks, or noise",
} as const;
/** status: the only ask is a ticket status move, so nothing is re-checked. */
export type FollowUpOutcome = keyof typeof FOLLOW_UP_OUTCOMES | "status";

export interface FollowUpInput {
  /** Replies since lastReply that Foreman already handled; context only. */
  earlier?: string[];
  /** Foreman's last message in the requester thread. */
  lastReply: string;
  /** Everything said in the thread since, oldest first, as relayed. */
  replies: string[];
}

export const followUpQuestions = (): Record<string, JevQuestion> => ({
  follow_up: {
    criteria: { ...FOLLOW_UP_OUTCOMES },
    instructions:
      "Foreman posted lastReply in a thread shared by several people (a Slack thread, or a support team's notes on a customer conversation). Each reply is 'Name: text'. @Foreman is Foreman; @teammate is a person, never Foreman. Taking the replies since then together, do they need a message from Foreman? lastReply is Foreman's own message: a reply that comes right after it, with no message from a person in between, and follows on from it, such as a question about what it said or what happens next, is for Foreman. Without an @Foreman mention, a reply that mentions @teammate, or answers or continues what another person in the thread said, is for people even when it carries a new fact, and while a question between people is open Foreman waits. Anything that mentions @Foreman is for Foreman, and so is a question addressed to no one that does not continue an exchange between people. earlier, when present, holds replies Foreman already handled: read them as context, and judge only replies.",
    type: "choice",
  },
  status_only: {
    instructions:
      "Is the only thing the replies ask of Foreman to move the ticket to a status (done, complete, closed, cancelled), with no question for Foreman and no request to check, verify, or change anything else?",
    type: "boolean",
  },
});

/**
 * Staying quiet needs a clear call; when unsure, the requester is answered.
 * A clear status-only ask is answered without re-checking the work.
 */
export function resolveFollowUp(answers: Answers): FollowUpOutcome {
  const { choice, confidence } = choiceOf(answers.follow_up);
  if (choice === "skip" && confidence >= BARS.followUp) {
    return "skip";
  }
  return answers.status_only &&
    probabilityOf(answers.status_only) >= BARS.statusOnly
    ? "status"
    : "respond";
}

/**
 * The prompt into a ticket's Foreman session: one line naming who replied in
 * Slack (the Asks receiver) or added a note in the Acquisity support inbox.
 * The reply itself is under the requester thread's anchor comment.
 */
export const SLACK_PROMPT =
  /^\*\*([^*\n]{1,100})\*\* (?:replied in Slack|added a note in the support inbox)\.$/u;

/** Foreman's bot user in the intake Slack workspace, as the receiver mentions it. */
const FOREMAN_MENTION = /<@U0BQ5QMHM7D(?:\|[^>]*)?>/gu;
const SLACK_MENTION = /<@[A-Za-z0-9]+(?:\|[^>]*)?>/gu;
// The Asks receiver heads each relayed reply with "<link> **Name** replied in
// Slack:", and the support inbox each note with "**Name** added a note in the
// support inbox:". The link always names Foreman, so it says nothing about
// who a reply is for.
export const RELAY_HEADER =
  /^[^\n]{0,300}?(?:\*\*([^*\n]{1,100})\*\* )?(?:replied in Slack|added a note in the support inbox):/u;

/**
 * Rewrites a relayed reply as "Name: text" with a mention of Foreman as
 * @Foreman and every other Slack mention as @teammate, since Jev cannot
 * resolve Slack ids. The receiver relays a reply that mentions the bot like
 * any other, so "@Foreman move this to done" must not read as a hand-off.
 */
export const followUpText = (reply: string): string => {
  const name = RELAY_HEADER.exec(reply)?.[1] ?? "Someone";
  const text = reply
    .replace(RELAY_HEADER, "")
    .replace(FOREMAN_MENTION, "@Foreman")
    .replace(SLACK_MENTION, "@teammate")
    .trim();
  return `${name}: ${text}`;
};

/**
 * A reply that is only a mention is what wakes Foreman, not something said,
 * so code skips it without asking Jev.
 */
export async function decideFollowUp(
  input: FollowUpInput,
  opts?: JevOptions
): Promise<FollowUpOutcome> {
  const said = (list: string[] = []) =>
    list
      .filter(
        (reply) =>
          reply.replace(RELAY_HEADER, "").replace(SLACK_MENTION, "").trim() !==
          ""
      )
      .map(followUpText);
  const replies = said(input.replies);
  if (replies.length === 0) {
    return "skip";
  }
  const earlier = said(input.earlier);
  return resolveFollowUp(
    await askJev(
      followUpQuestions(),
      {
        lastReply: input.lastReply,
        replies,
        ...(earlier.length > 0 ? { earlier } : {}),
      },
      opts
    )
  );
}
