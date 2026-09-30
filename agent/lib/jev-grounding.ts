import {
  askJev,
  type JevAnswer,
  type JevOptions,
  type JevQuestion,
  probabilityOf,
} from "./jev.js";
import { BARS } from "./jev-decisions.js";

const MAX_CLAIMS = 40;
const CLAIM_BREAK = /(?<=[.!?])\s+|\n+/u;
const HAS_LETTER = /\p{L}/u;
const CLOSING_PUNCTUATION = /([.!?]*)$/u;
const UNCONFIRMED = " (unconfirmed)";

export interface GroundingFlag {
  claim: string;
  reason: "done_unconfirmed" | "not_shown";
}

export interface GroundingResult {
  checked: boolean;
  flagged: GroundingFlag[];
  /** Why an unchecked draft was not checked, for the ops log. */
  reason?: "oversized" | "jev_failed";
  /** The reply to send: the draft with each flagged claim marked unconfirmed. */
  reply: string;
}

/** Sentences and lines of a draft, each judged as one claim. */
export const splitClaims = (draft: string): string[] =>
  draft
    .split(CLAIM_BREAK)
    .map((claim) => claim.trim())
    .filter((claim) => HAS_LETTER.test(claim))
    .slice(0, MAX_CLAIMS + 1);

export const groundingQuestions = (
  claims: string[]
): Record<string, JevQuestion> =>
  Object.fromEntries(
    claims.flatMap((_claim, index) => [
      [
        `shown_${index}`,
        {
          instructions: `Does the evidence show what the claim whose index is ${index} says? A claim that asserts nothing (a question, an offer, a greeting) counts as shown.`,
          type: "boolean",
        } satisfies JevQuestion,
      ],
      [
        `done_${index}`,
        {
          instructions: `Does the claim whose index is ${index} say work is done: fixed, shipped, merged, sent, deployed, resolved, or complete?`,
          type: "boolean",
        } satisfies JevQuestion,
      ],
    ])
  );

/** Marks a claim unconfirmed before its closing punctuation. */
const markUnconfirmed = (claim: string): string =>
  claim.replace(CLOSING_PUNCTUATION, `${UNCONFIRMED}$1`);

/**
 * Which claims to flag and the reply with each one marked. A flag only
 * changes the wording; the reply always goes out.
 */
export function resolveGrounding(
  draft: string,
  claims: string[],
  answers: Record<string, JevAnswer>
): GroundingResult {
  const flagged: GroundingFlag[] = [];
  let cursor = 0;
  let reply = "";
  claims.forEach((claim, index) => {
    const shown = probabilityOf(answers[`shown_${index}`]);
    let reason: GroundingFlag["reason"] | undefined;
    if (shown < BARS.grounded) {
      reason = "not_shown";
    } else if (
      probabilityOf(answers[`done_${index}`]) >= BARS.signal &&
      shown < BARS.doneClaim
    ) {
      reason = "done_unconfirmed";
    }
    if (reason) {
      flagged.push({ claim, reason });
    }
    const start = draft.indexOf(claim, cursor);
    reply += draft.slice(cursor, start);
    reply +=
      reason && !claim.includes(UNCONFIRMED.trim())
        ? markUnconfirmed(claim)
        : claim;
    cursor = start + claim.length;
  });
  reply += draft.slice(cursor);
  return { checked: true, flagged, reply };
}

/**
 * Checks a draft reply against the turn's evidence. Never withholds it: a
 * Jev failure or timeout returns the draft unchanged, and only a cancelled
 * turn throws.
 */
export async function checkGrounding(
  input: { draft: string; evidence: string },
  opts?: JevOptions
): Promise<GroundingResult> {
  const claims = splitClaims(input.draft);
  if (claims.length > MAX_CLAIMS) {
    return {
      checked: false,
      flagged: [],
      reason: "oversized",
      reply: input.draft,
    };
  }
  if (claims.length === 0) {
    return { checked: true, flagged: [], reply: input.draft };
  }
  try {
    const answers = await askJev(
      groundingQuestions(claims),
      {
        claims: claims.map((text, index) => ({ index, text })),
        evidence: input.evidence,
      },
      opts
    );
    return resolveGrounding(input.draft, claims, answers);
  } catch (error) {
    if (opts?.signal?.aborted) {
      throw error;
    }
    return {
      checked: false,
      flagged: [],
      reason: "jev_failed",
      reply: input.draft,
    };
  }
}
