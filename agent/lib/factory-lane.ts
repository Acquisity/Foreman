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
// inside names: a bare word match reads `factory/repo`, `owner/factory`, and
// `channels/factory.ts` as requests, which would hand a slug or a file path the
// authority the ticket keeps free-text tokens from having. So the word counts
// only when it stands on its own, outside a slug or path component, and only
// when the clause carrying it is not a negation ("do not use the factory").
// Input is length-bounded before matching, like every other pattern run over
// channel text.
const MAX_INTENT_TEXT_LENGTH = 10_000;
// Not preceded by a word character, `/`, or `.`, and not followed by a word
// character, a `/`, or a file extension. A trailing sentence period still
// counts, so "take this through the factory." reads as a request.
const FACTORY_WORD_PATTERN = /(?<![\w/.])factory(?![\w/]|\.[a-z0-9])/giu;
// A negator earlier in the same clause reverses the request. Apostrophes are
// stripped before matching so "don't" and "dont" read alike.
const NEGATION_PATTERN =
  /\b(?:no|not|never|without|avoid|skip|dont|doesnt|didnt|cant|wont|isnt)\b[^.!?;\n]*$/iu;
const APOSTROPHES = /['\u2019]/gu;

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

/** Whether a delivered message explicitly asks for the factory. */
export const isFactoryRequest = (content: string | UserContent): boolean => {
  const text = deliveredText(content).slice(0, MAX_INTENT_TEXT_LENGTH);
  for (const match of text.matchAll(FACTORY_WORD_PATTERN)) {
    const clause = text.slice(0, match.index).replace(APOSTROPHES, "");
    if (!NEGATION_PATTERN.test(clause)) {
      return true;
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
