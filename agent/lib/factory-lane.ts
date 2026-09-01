import type { UserContent } from "ai";
import type { SessionAuthContext } from "eve/context";
import { repositoryFromAuth } from "./repository.js";
import { isAutonomous, isIntakeOnly, isTrusted } from "./trust.js";

/**
 * Whether a session lane carries the loadable factory skill.
 *
 * @remarks
 * This is capability composition, not authorization. Every write the factory
 * performs stays gated where it already is: `agent/lib/trust.ts` decides trust,
 * `agent/lib/github/approval.ts` decides approval, and `intakeOnlyPolicy`
 * denies push and pull-request creation whatever this module returns. What is
 * decided here is only whether the station procedure is advertised as a
 * loadable skill, which is a catalog cost every ordinary Slack turn was paying
 * for a path it never takes.
 *
 * The decision reads stamps the dispatching channel applied to the signed
 * event, never model-readable content. A dynamic skill resolver runs at
 * `turn.started`, where eve hands it an empty `ctx.messages`, so message text
 * could not be read here even if it were trustworthy: the channel is the only
 * place that sees the delivery, and it is the place that already decides trust
 * and repository selection.
 */

/**
 * Auth attribute marking a session whose dispatching channel read an explicit
 * request for the factory out of the message it delivered.
 *
 * @remarks
 * Deliberately separate from the trust and repository stamps. Intent says what
 * the requester asked for; it grants nothing on its own in an intake-only
 * channel, where {@link factorySkillAvailable} still requires trust.
 */
export const FACTORY_INTENT_ATTRIBUTE = "factoryIntent";

// A request names the factory by word, affirmatively. `factory` is not a term
// ordinary Acquisity conversation reaches for, but it is a term that appears
// inside names: matching it anywhere reads `factory/repo`, `owner/factory`,
// `channels/factory.ts`, and `factory-tools/repo` as requests, which would hand
// a slug or a file path the authority the ticket keeps free-text tokens from
// having. So the decision is made on the whole surrounding token rather than on
// the characters next to the word, and a token that is a name rather than the
// word asks for nothing.
// Input is length-bounded before matching, like every other pattern run over
// channel text.
const MAX_INTENT_TEXT_LENGTH = 10_000;
const FACTORY_WORD = "factory";
// Punctuation a word can be wrapped in without being joined to anything: a
// sentence period, a comma, quotes, brackets. Only the ends of a token are
// stripped, so a `.` inside one survives and `factory.ts` stays a filename
// while "the factory." stays the word. `/`, `-`, `_`, `@`, and `#` join a slug,
// a path, or a handle wherever they sit, so they are never stripped, and a
// letter of any script is not stripped either. What is left has to equal the
// word exactly, which is what makes `factory-pipeline.ts`, `factory-tools/repo`
// and `factoryé` names rather than requests.
const WRAPPING_PUNCTUATION = /^[^\p{L}\p{N}/\-_@#]+|[^\p{L}\p{N}/\-_@#]+$/gu;
const APOSTROPHES = /['\u2019]/gu;
const WHITESPACE = /\s+/u;
// Ends a clause, so nothing before it belongs to the phrase that follows.
const CLAUSE_END = /[,.!?;:]$/u;
const NEGATORS = new Set([
  "avoid",
  "cant",
  "didnt",
  "doesnt",
  "dont",
  "isnt",
  "never",
  "no",
  "not",
  "skip",
  "without",
  "wont",
]);
// How far back a negator can reach. Negation belongs to the factory phrase, so
// the scan stops at the clause before it ("no problem, run the factory" asks
// for the factory) and at this many words in any case, which keeps a negator
// from an earlier part of a long unpunctuated sentence from reversing a request
// it has nothing to do with. A negator set off by commas inside the same clause
// ("do not, ever, use the factory") reads as a separate phrase and is missed;
// the reader takes the request at its word rather than guessing.
const NEGATION_REACH = 6;

const deliveredText = (content: string | UserContent): string => {
  if (typeof content === "string") {
    return content;
  }
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push(part.text);
    }
  }
  return parts.join("\n");
};

/** The word a token carries, once wrapping punctuation is off it. */
const bareWord = (token: string): string =>
  token
    .replace(WRAPPING_PUNCTUATION, "")
    .replace(APOSTROPHES, "")
    .toLowerCase();

/** Whether a negator attached to this phrase reverses the word at `index`. */
const isNegated = (words: readonly string[], index: number): boolean => {
  const reach = Math.max(0, index - NEGATION_REACH);
  for (let before = index - 1; before >= reach; before -= 1) {
    const token = words[before] ?? "";
    if (CLAUSE_END.test(token)) {
      return false;
    }
    if (NEGATORS.has(bareWord(token))) {
      return true;
    }
  }
  return false;
};

/** Whether a delivered message explicitly asks for the factory. */
export const isFactoryRequest = (content: string | UserContent): boolean => {
  const text = deliveredText(content).slice(0, MAX_INTENT_TEXT_LENGTH);
  // A line break ends a clause too, so each line is read on its own.
  for (const line of text.split("\n")) {
    const words = line.split(WHITESPACE).filter(Boolean);
    for (const [index, token] of words.entries()) {
      if (bareWord(token) === FACTORY_WORD && !isNegated(words, index)) {
        return true;
      }
    }
  }
  return false;
};

/** Returns a copy of `auth` carrying the {@link FACTORY_INTENT_ATTRIBUTE}. */
export const stampFactoryIntent = (
  auth: SessionAuthContext
): SessionAuthContext => ({
  ...auth,
  attributes: { ...auth.attributes, [FACTORY_INTENT_ATTRIBUTE]: "true" },
});

/** Whether the dispatching channel read explicit factory intent. */
export const hasFactoryIntent = (auth: SessionAuthContext | null): boolean =>
  auth !== null && auth.attributes[FACTORY_INTENT_ATTRIBUTE] === "true";

/**
 * Whether this session is offered the factory skill.
 *
 * @remarks
 * An unattended factory run gets `FACTORY_PROMPT`, which embeds the same
 * `PIPELINE` text inline, so the skill would only duplicate it. An intake-only
 * channel needs explicit trusted intent, because conversation there is the
 * normal case and repository work is denied anyway. Everywhere else, either
 * explicit intent or a selected repository is enough, and a repository is
 * selected only by a signed webhook or a full GitHub URL: a bare `owner/repo`
 * token in free text creates no repository authority (see
 * `extractRepositoryUrls`), so it creates no factory authority either.
 */
export const factorySkillAvailable = (
  auth: SessionAuthContext | null
): boolean => {
  if (isAutonomous(auth)) {
    return false;
  }
  if (isIntakeOnly(auth)) {
    return hasFactoryIntent(auth) && isTrusted(auth);
  }
  return hasFactoryIntent(auth) || repositoryFromAuth(auth) !== null;
};
