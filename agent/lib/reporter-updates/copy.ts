export type Stage = "received" | "owner" | "fixed" | "not_fixed";
export type NotFixedReason = "duplicate" | "not_a_bug" | "no_change";

export const STAGES: readonly Stage[] = [
  "received",
  "owner",
  "fixed",
  "not_fixed",
];

export const MAX_UPDATE_WORDS = 50;

const NAME = "[\\p{L}][\\p{L}'-]{0,39}";
const NAME_ONLY = new RegExp(`^${NAME}$`, "u");
const WHITESPACE = /\s+/u;
const WHITESPACE_RUN = /\s+/gu;
const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/gu;
const SLOT = "\u0000";
const NOTHING_TO_DO = "Nothing for you to do";

export const firstName = (fullName: string | null): string | null => {
  const [first] = (fullName ?? "").trim().split(WHITESPACE);
  return first && NAME_ONLY.test(first) ? first : null;
};

export const receivedText = (owner: string | null): string =>
  owner
    ? `We've received your report and ${owner} is looking after it. ${NOTHING_TO_DO} right now. We'll write here again as soon as there's news.`
    : `We've received your report and our team is looking into it. ${NOTHING_TO_DO} right now. We'll write here again as soon as there's news.`;

export const ownerText = (owner: string): string =>
  `${owner} is now looking after your report. ${NOTHING_TO_DO}. We'll write here again as soon as there's news.`;

export const fixedText = (): string =>
  "Good news: this is fixed and live now. Please try it again. If it still doesn't work, reply here and we'll look straight away.";

const NOT_FIXED_REASONS: Record<NotFixedReason, string> = {
  duplicate: `We looked into this. Someone had already reported the same thing, so we're tracking it under that report instead of this one. ${NOTHING_TO_DO}.`,
  no_change: `We looked into this and closed it without a change to the product. ${NOTHING_TO_DO}. If it still looks wrong, reply here and we'll look again.`,
  not_a_bug: `We looked into this and nothing is broken: it works the way it's designed to right now. ${NOTHING_TO_DO}. If it doesn't match what you saw, reply here.`,
};

export const notFixedText = (reason: NotFixedReason): string =>
  NOT_FIXED_REASONS[reason];

const REASON_KEYS = Object.keys(NOT_FIXED_REASONS) as NotFixedReason[];

export const PAST_TEXTS: Record<Stage, readonly string[]> = {
  fixed: [],
  not_fixed: [],
  owner: [],
  received: [],
};

const exactly = (texts: readonly string[]): RegExp =>
  new RegExp(
    `^(?:${texts
      .map((text) => text.replace(REGEXP_SPECIALS, "\\$&").replace(SLOT, NAME))
      .join("|")})$`,
    "u"
  );

export const STAGE_PATTERNS: Record<Stage, RegExp> = {
  fixed: exactly([fixedText(), ...PAST_TEXTS.fixed]),
  not_fixed: exactly([
    ...REASON_KEYS.map(notFixedText),
    ...PAST_TEXTS.not_fixed,
  ]),
  owner: exactly([ownerText(SLOT), ...PAST_TEXTS.owner]),
  received: exactly([
    receivedText(null),
    receivedText(SLOT),
    ...PAST_TEXTS.received,
  ]),
};

const RECEIVED_WITH_OWNER = exactly([receivedText(SLOT)]);

const normalized = (body: string): string =>
  body.trim().replace(WHITESPACE_RUN, " ");

export const stageOfBody = (body: string): Stage | null => {
  const text = normalized(body);
  return STAGES.find((stage) => STAGE_PATTERNS[stage].test(text)) ?? null;
};

export const coversOf = (body: string): Stage[] => {
  const stage = stageOfBody(body);
  if (stage === "received" && RECEIVED_WITH_OWNER.test(normalized(body))) {
    return ["received", "owner"];
  }
  return stage ? [stage] : [];
};

export const isReporterUpdate = (body: string): boolean =>
  stageOfBody(body) !== null;

export const withoutReporterUpdates = <
  T extends { body: string; userId: string | null },
>(
  comments: readonly T[],
  foremanUserId: string
): T[] =>
  comments.filter(
    (comment) =>
      !(comment.userId === foremanUserId && isReporterUpdate(comment.body))
  );

export const wordCount = (text: string): number =>
  text.split(WHITESPACE).filter(Boolean).length;

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
];

export const bannedWordsIn = (text: string): string[] =>
  BANNED_WORD_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(
    ([word]) => word
  );
