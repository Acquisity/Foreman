import { commentIdFor } from "./comment-id.js";

export type Stage = "received" | "fixed" | "not_fixed";
export type LedgerStage = Stage | "owner";
export type NotFixedReason = "duplicate" | "not_a_bug" | "closed";

export const STAGES: readonly Stage[] = ["received", "fixed", "not_fixed"];
export const LEDGER_STAGES: readonly LedgerStage[] = [...STAGES, "owner"];

export const MAX_UPDATE_WORDS = 40;
export const MAX_PHRASE_WORDS = 15;
export const MAX_REASON_WORDS = 10;
export const MAX_STEPS_WORDS = 25;

const NAME = "[\\p{L}][\\p{L}'-]{0,39}";
const NAME_ONLY = new RegExp(`^${NAME}$`, "u");
const WHITESPACE = /\s+/u;
const WHITESPACE_RUN = /\s+/gu;
const TRAILING_STOPS = /[\s.!?;:,]+$/u;
const MARKUP = /[`*#<>[\]|_~{}]|https?:|www\./iu;
const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/gu;
const SLOT = "\u0000";

export const wordCount = (text: string): number =>
  text.split(WHITESPACE).filter(Boolean).length;

export const firstName = (fullName: string | null): string | null => {
  const [first] = (fullName ?? "").trim().split(WHITESPACE);
  return first && NAME_ONLY.test(first) ? first : null;
};

const BANNED_WORD_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["deploy", /\bdeploy/iu],
  ["merge", /\bmerg/iu],
  ["PR", /\bPRs?\b/u],
  ["pull request", /\bpull requests?\b/iu],
  ["CI", /\bCI\b/u],
  ["Linear", /\blinear\b/iu],
  ["root cause", /\broot cause\b/iu],
  ["commit", /\bcommit/iu],
  ["ticket", /\btickets?\b/iu],
  ["issue id", /\b[A-Z]{2,6}-\d+\b/u],
  ["file path", /(?:\/[\w.-]+){2,}/u],
  ["error code", /\b(?:HTTP|error)\s?\d{3}\b/iu],
  ["model name", /\b(?:claude|gpt|gemini|opus|sonnet|haiku|llm)\b/iu],
  ["developer", /\b(?:developers?|engineers?|engineering)\b/iu],
  [
    "filler",
    /\b(?:good news|nothing for you to do|as soon as there's news)\b/iu,
  ],
];

export const bannedWordsIn = (text: string): string[] =>
  BANNED_WORD_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(
    ([word]) => word
  );

const mentions = (text: string, name: string | null): boolean =>
  name !== null &&
  new RegExp(`(?:^|[^\\p{L}])${name.replace(REGEXP_SPECIALS, "\\$&")}(?:$|[^\\p{L}])`, "iu").test(
    text
  );

const usable = (
  text: string,
  maxWords: number,
  avoidName: string | null
): boolean =>
  text.length > 0 &&
  wordCount(text) <= maxWords &&
  !MARKUP.test(text) &&
  bannedWordsIn(text).length === 0 &&
  !mentions(text, avoidName);

/**
 * A model-written phrase that sits inside a sentence: one line, no closing
 * stop, at most `maxWords`, no markup, no banned word and not the owner's
 * name. Anything else is refused, so the caller uses its fallback line.
 */
export const cleanPhrase = (
  raw: string | null | undefined,
  maxWords: number,
  avoidName: string | null = null
): string | null => {
  const text = (raw ?? "")
    .replace(WHITESPACE_RUN, " ")
    .trim()
    .replace(TRAILING_STOPS, "");
  return usable(text, maxWords, avoidName) ? text : null;
};

/** One or two model-written sentences, ending with a full stop. */
export const cleanSteps = (
  raw: string | null | undefined,
  maxWords: number = MAX_STEPS_WORDS,
  avoidName: string | null = null
): string | null => {
  const phrase = cleanPhrase(raw, maxWords, avoidName);
  return phrase ? `${phrase}.` : null;
};

const fits = (text: string): boolean =>
  wordCount(text) <= MAX_UPDATE_WORDS && bannedWordsIn(text).length === 0;

const firstFitting = (candidates: readonly (string | null)[]): string | null =>
  candidates.find((text): text is string => text !== null && fits(text)) ??
  null;

export const RECEIVED_FALLBACK =
  "Thanks, got it. We're looking into this and will reply here when we know more.";
export const FIXED_FALLBACK =
  "This is fixed and live now. Give it a go, and reply here if it's still not right.";
export const LIVE_FALLBACK =
  "This is live now. Reply here if anything isn't working as you expected.";
export const DUPLICATE_TEXT =
  "Thanks. Someone flagged the same thing, so we're handling both together. We'll reply here when it's fixed.";

export const receivedText = (what: string | null): string =>
  firstFitting([
    what
      ? `Thanks, got it. We're looking into ${what} and will reply here when we know more.`
      : null,
  ]) ?? RECEIVED_FALLBACK;

export const fixedText = (what: string | null, steps: string | null): string =>
  firstFitting([
    what && steps
      ? `Fixed: ${what}. ${steps} Reply here if it's still not right.`
      : null,
    what
      ? `Fixed: ${what}. Give it a go, and reply here if it's still not right.`
      : null,
  ]) ?? FIXED_FALLBACK;

export const liveText = (what: string | null, steps: string | null): string =>
  firstFitting([what && steps ? `This is live: ${what}. ${steps}` : null]) ??
  LIVE_FALLBACK;

/** Null when there is no usable phrase: done with no evidence posts nothing. */
export const doneText = (what: string | null): string | null =>
  firstFitting([
    what ? `Done: ${what}. Reply here if anything still looks off.` : null,
  ]);

const withReason = (reason: string | null): string =>
  reason ? `: ${reason}` : "";

const notABugText = (reason: string | null): string =>
  `We checked, and this is working the way it's meant to right now${withReason(reason)}. If that's not what you saw, reply here with a screenshot and we'll take another look.`;

const closedText = (reason: string | null): string =>
  `We've looked into this and won't be changing anything for now${withReason(reason)}. Reply here if it's still causing you trouble.`;

export const notFixedText = (
  reason: NotFixedReason,
  why: string | null = null
): string => {
  if (reason === "duplicate") {
    return DUPLICATE_TEXT;
  }
  const build = reason === "not_a_bug" ? notABugText : closedText;
  return firstFitting([why ? build(why) : null]) ?? build(null);
};

/**
 * Exact texts the first version posted. Every v2 message is recognised by its
 * comment id instead, because its wording is model-written; these keep
 * threads that already hold a v1 message from getting a second one.
 */
export const PAST_TEXTS: Record<LedgerStage, readonly string[]> = {
  fixed: [
    "Good news: this is fixed and live now. Please try it again. If it still doesn't work, reply here and we'll look straight away.",
  ],
  not_fixed: [
    "We looked into this and have closed it. Nothing for you to do. If it still looks wrong, reply here and we'll look again.",
    "We looked into this. Someone had already reported the same thing, so we're tracking it under that report instead of this one. Nothing for you to do.",
    "We looked into this and nothing is broken: it works the way it's designed to right now. Nothing for you to do. If it doesn't match what you saw, reply here.",
    "We looked into this and no change to the product was needed. Nothing for you to do. If it still looks wrong, reply here and we'll look again.",
    "We looked into this and closed it without a change to the product. Nothing for you to do. If it still looks wrong, reply here and we'll look again.",
  ],
  owner: [
    `${SLOT} is now looking after your report. Nothing for you to do. We'll write here again as soon as there's news.`,
  ],
  received: [
    "We've received your report and our team is looking into it. Nothing for you to do right now. We'll write here again as soon as there's news.",
    `We've received your report and ${SLOT} is looking after it. Nothing for you to do right now. We'll write here again as soon as there's news.`,
  ],
};

const exactly = (texts: readonly string[]): RegExp =>
  new RegExp(
    `^(?:${texts
      .map((text) => text.replace(REGEXP_SPECIALS, "\\$&").replace(SLOT, NAME))
      .join("|")})$`,
    "u"
  );

const PAST_PATTERNS: Record<LedgerStage, RegExp> = {
  fixed: exactly(PAST_TEXTS.fixed),
  not_fixed: exactly(PAST_TEXTS.not_fixed),
  owner: exactly(PAST_TEXTS.owner),
  received: exactly(PAST_TEXTS.received),
};

const RECEIVED_WITH_OWNER = exactly(
  PAST_TEXTS.received.filter((text) => text.includes(SLOT))
);

const normalized = (body: string): string =>
  body.trim().replace(WHITESPACE_RUN, " ");

/** The stages an already-posted v1 message covers, from its exact text. */
export const coversOf = (body: string): LedgerStage[] => {
  const text = normalized(body);
  const stage = LEDGER_STAGES.find((candidate) =>
    PAST_PATTERNS[candidate].test(text)
  );
  if (stage === "received" && RECEIVED_WITH_OWNER.test(text)) {
    return ["received", "owner"];
  }
  return stage ? [stage] : [];
};

/** The stage a comment was posted as, read from its comment id. */
export const stageOfCommentId = (
  identifier: string,
  id: string
): LedgerStage | null =>
  LEDGER_STAGES.find((stage) => commentIdFor(identifier, stage) === id) ??
  null;

export const isReporterUpdate = (
  identifier: string,
  comment: { body: string; id: string }
): boolean =>
  stageOfCommentId(identifier, comment.id) !== null ||
  coversOf(comment.body).length > 0;

export const withoutReporterUpdates = <
  T extends { body: string; id: string; userId: string | null },
>(
  comments: readonly T[],
  foremanUserId: string,
  identifier: string
): T[] =>
  comments.filter(
    (comment) =>
      !(
        comment.userId === foremanUserId &&
        isReporterUpdate(identifier, comment)
      )
  );
