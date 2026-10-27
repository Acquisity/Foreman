import {
  cleanPhrase,
  cleanSteps,
  doneText,
  firstName,
  fixedText,
  liveText,
  MAX_PHRASE_WORDS,
  MAX_REASON_WORDS,
  MAX_STEPS_WORDS,
  type NotFixedReason,
  notFixedText,
  receivedText,
} from "./copy.js";
import {
  type ClosingComment,
  changeKindOf,
  DEPLOY_REPOSITORY,
  type Planned,
  type PullFacts,
  pullContext,
  type TicketFacts,
} from "./plan.js";
import type { ReporterWriter } from "./writer.js";

const commentsOf = (
  facts: TicketFacts,
  authors: readonly ClosingComment["author"][]
): string[] =>
  facts.closingComments
    .filter((comment) => authors.includes(comment.author))
    .map((comment) => comment.body);

export const composeReceived = async (
  facts: TicketFacts,
  write: ReporterWriter
): Promise<Planned> => {
  const reply = await write({
    description: facts.description,
    kind: "received",
    title: facts.title,
  });
  const what = cleanPhrase(
    reply.what,
    MAX_PHRASE_WORDS,
    firstName(facts.assignee)
  );
  return {
    covers: ["received"],
    stage: "received",
    text: receivedText(what),
  };
};

/**
 * A duplicate gets its fixed line. Any other close reads the closing comments,
 * Foreman's and staff's: the writer gives a one-line reason, and for a close
 * with no User Error or Platform Limitation label it also judges whether the
 * product works as designed (not a bug) or will not be changed (closed). A
 * failed call, or no comments, posts closed without a reason, unless the label
 * already said not a bug.
 */
export const composeNotFixed = async (
  facts: TicketFacts,
  reason: NotFixedReason,
  write: ReporterWriter
): Promise<Planned> => {
  const planned = (text: string): Planned => ({
    covers: ["not_fixed"],
    stage: "not_fixed",
    text,
  });
  const comments = commentsOf(facts, ["foreman", "staff"]);
  if (reason === "duplicate" || comments.length === 0) {
    return planned(notFixedText(reason));
  }
  const reply = await write({ comments, kind: "reason", title: facts.title });
  const why = cleanPhrase(
    reply.what,
    MAX_REASON_WORDS,
    firstName(facts.assignee)
  );
  const settled =
    reason === "not_a_bug" || reply.asDesigned === true
      ? "not_a_bug"
      : "closed";
  return planned(notFixedText(settled, why));
};

/**
 * The fixed message for a bug, or the live message with how-to steps for a
 * feature, from the merged pull requests' Solution and How it works sections.
 * `source` is the ticket the change was made on: the ticket itself, or the
 * original a duplicate points at.
 */
export const composeChange = async (
  source: TicketFacts,
  pulls: readonly PullFacts[],
  write: ReporterWriter
): Promise<Planned> => {
  const kind = changeKindOf(source.labels, pulls);
  const pull = pulls
    .filter(
      (candidate) =>
        candidate.state === "merged" && candidate.repo === DEPLOY_REPOSITORY
    )
    .map((candidate) => pullContext(candidate.body))
    .filter(Boolean)
    .join("\n\n");
  const reply = await write({
    description: source.description,
    kind: kind === "feature" ? "live" : "fixed",
    pull,
    title: source.title,
  });
  const owner = firstName(source.assignee);
  const what = cleanPhrase(reply.what, MAX_PHRASE_WORDS, owner);
  const steps = cleanSteps(reply.steps, MAX_STEPS_WORDS, owner);
  return {
    covers: ["fixed"],
    stage: "fixed",
    text: kind === "feature" ? liveText(what, steps) : fixedText(what, steps),
  };
};

/** Null when no closing comment from staff describes a change: post nothing. */
export const composeDone = async (
  facts: TicketFacts,
  write: ReporterWriter
): Promise<Planned | null> => {
  const comments = commentsOf(facts, ["staff"]);
  if (comments.length === 0) {
    return null;
  }
  const reply = await write({ comments, kind: "done", title: facts.title });
  const text = doneText(
    cleanPhrase(reply.what, MAX_PHRASE_WORDS, firstName(facts.assignee))
  );
  return text ? { covers: ["fixed"], stage: "fixed", text } : null;
};
