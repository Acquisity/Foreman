import type { SlackChannelEvents } from "eve/channels/slack";
import { defineState, type SessionAuthContext } from "eve/context";

/**
 * The Slack final-delivery action gate.
 *
 * @remarks
 * A polished final reply can still invent an operation: "Happy to rebook the
 * affected calls" reads well and commits Acquisity to something nobody
 * verified exists. Prompt rules alone did not stop it (ENG-13108), so the
 * boundary lives where the post happens. The Slack channel runs every
 * terminal assistant message of an intake-only session through
 * {@link decideSlackDelivery} before `thread.post`, and posts one fixed
 * fallback instead when the message fails.
 *
 * The gate has two halves, and neither is enough alone:
 *
 * - {@link findActionStatements} finds sentences that commit an actor to an
 *   operation (a promise, an offer, a recommendation, or a claim that a write
 *   already happened). It is a bounded pattern list, not a semantic judge.
 * - Every flagged sentence must be covered by an attestation recorded this
 *   turn through `attest_action_statement`, carrying the evidence contract
 *   the ticket asks for: a `completed` claim needs a successful tool result
 *   observed by the channel for the tool it names; an `available` option
 *   needs the procedure, feasibility, safety constraints, and authorized
 *   owner, and the sentence must name that owner.
 *
 * A flagged sentence with no matching attestation fails closed. Ordinary
 * factual prose, customer-directed product steps, and "no safe action was
 * confirmed" wording carry no actor commitment and pass untouched.
 *
 * Scope: the gate runs only for sessions carrying the intake-only stamp.
 * Developer channels are Aaron's own working surface, where "pushed the
 * branch and opened the PR" is the normal shape of a final message.
 */

export const SLACK_DELIVERY_FALLBACK =
  "I couldn't safely post that response. Please ask me to try again.";

// Slack posts are bounded well below this; the detector never scans more.
const MAX_MESSAGE_LENGTH = 40_000;
const MAX_SENTENCE_LENGTH = 1000;
const MIN_ATTESTED_LENGTH = 10;

// Verbs that commit someone to an operation. Investigation verbs (check,
// confirm, see, explain) are deliberately absent: "I can confirm the campaign
// is paused" is a finding, not an action.
const ACTION_VERBS =
  "rebook|re-book|book|reschedule|fix|repair|recover|restore|resend|re-send|replay|re-run|rerun|retry|re-trigger|retrigger|trigger|reset|refund|credit|reimburse|adjust|override|update|change|configure|reconfigure|correct|patch|deploy|push|roll back|rollback|migrate|escalate|file|create|open|close|reopen|cancel|delete|remove|add|apply|enable|disable|run|process|monitor|watch|track|keep an eye|follow up|check back|look into|dig into|investigate|review|handle|take care|sort|resolve|relink|re-link|reconnect|resync|re-sync|sync";

const ACTION_PAST =
  "rebooked|re-booked|booked|rescheduled|fixed|repaired|recovered|restored|resent|re-sent|replayed|re-ran|reran|retried|re-triggered|retriggered|triggered|reset|refunded|credited|reimbursed|adjusted|overrode|overridden|updated|changed|configured|reconfigured|corrected|patched|deployed|pushed|rolled back|migrated|escalated|filed|created|opened|closed|reopened|cancelled|canceled|deleted|removed|added|applied|enabled|disabled|relinked|re-linked|reconnected|resynced|re-synced|synced";

const TEAM_ACTOR =
  "support|engineering|foreman|the (?:support |engineering |dev |devs |product |billing )?team|our (?:team|devs|engineers|support|engineering)|the devs|the engineers";

const MODAL =
  "will|can|could|would|should|may|might|shall|needs? to|is able to|are able to|is going to|are going to|plans? to|intends? to";

const FILLER = String.raw`(?!not\b|never\b|no\b)(?:[\w'-]+\s+){0,3}?`;

// Every regex is a literal; nothing here is built from data.
const STATEMENT_PATTERNS: readonly RegExp[] = [
  // I'll rebook them / we can fix those / I could look into it
  new RegExp(
    String.raw`\b(?:i|we)(?:'ll|'d|'m going to|'re going to| will| can| could| would| should| may| might| shall| am going to| are going to| am able to| are able to| plan to| intend to| need to)\s+${FILLER}(?:${ACTION_VERBS})\b`,
    "iu"
  ),
  // happy to rebook / glad to help fix / let me update
  new RegExp(
    String.raw`\b(?:happy|glad|able|willing|ready|going) to\s+${FILLER}(?:${ACTION_VERBS})\b`,
    "iu"
  ),
  new RegExp(String.raw`\blet me\s+${FILLER}(?:${ACTION_VERBS})\b`, "iu"),
  // Support should rebook / the team will follow up / engineering can recover
  new RegExp(
    String.raw`\b(?:${TEAM_ACTOR})\s+(?:${MODAL})\s+${FILLER}(?:${ACTION_VERBS})\b`,
    "iu"
  ),
  // I updated the ticket / we've rebooked the calls
  new RegExp(
    String.raw`\b(?:i|we)(?:'ve| have)?\s+(?:just |already |now |also )?(?:${ACTION_PAST})\b`,
    "iu"
  ),
  // the ticket was updated / the Linear issue has been closed
  new RegExp(
    String.raw`\b(?:linear )?(?:ticket|issue)\s+(?:was|were|has been|have been|is now|are now|got)\s+(?:${ACTION_PAST}|assigned|moved|labell?ed|relabell?ed|prioriti[sz]ed|linked|commented on)\b`,
    "iu"
  ),
];

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+|\n+/u;

// Detection input only. The patterns carry ASCII apostrophes, and Slack
// markup between a contraction and its verb ("I'll *rebook*") would otherwise
// split a pattern apart. The raw sentence is what gets returned, so
// attestation matching stays aligned with `normalize`.
const SMART_APOSTROPHE = /[‘’`]/gu;
const DETECTION_MARKUP = /[*_~“”]/gu;
const forDetection = (sentence: string): string =>
  sentence.replace(SMART_APOSTROPHE, "'").replace(DETECTION_MARKUP, "");

/**
 * Sentences of `message` that commit an actor to an operation.
 *
 * @remarks
 * Detection is per sentence so an attestation can be matched to the exact
 * wording it covers. Negated modals ("could not recover") are skipped: they
 * state that nothing was done.
 */
export function findActionStatements(message: string): string[] {
  const text = message.slice(0, MAX_MESSAGE_LENGTH);
  const found: string[] = [];
  for (const raw of text.split(SENTENCE_BOUNDARY)) {
    const sentence = raw.trim().slice(0, MAX_SENTENCE_LENGTH);
    const candidate = forDetection(sentence);
    if (
      sentence.length > 0 &&
      STATEMENT_PATTERNS.some((pattern) => pattern.test(candidate))
    ) {
      found.push(sentence);
    }
  }
  return found;
}

export interface CompletedAttestation {
  sentence: string;
  state: "completed";
  /** The tool whose successful result this turn proves the action happened. */
  toolName: string;
}

export interface AvailableAttestation {
  owner: string;
  sentence: string;
  state: "available";
}

export type ActionAttestation = CompletedAttestation | AvailableAttestation;

export interface SlackDeliveryGate {
  attestations: ActionAttestation[];
  /** Tool names with a successful (non-error) result observed this turn. */
  succeededTools: string[];
  turnId: string;
}

export type AttestationRejection = "unproven-completion" | "owner-not-named";

export type SlackDeliveryRejection = "unattested-action" | AttestationRejection;

export type SlackDeliveryDecision =
  | { allowed: true; message: string }
  | { allowed: false; reason: SlackDeliveryRejection };

const MARKUP = /[*_~`"“”'‘’]/gu;
const WHITESPACE = /\s+/gu;
const TRAILING_PUNCTUATION = /[.!?,;:]+$/u;

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(MARKUP, "")
    .replace(WHITESPACE, " ")
    .trim()
    .replace(TRAILING_PUNCTUATION, "");

const PRONOUN_OWNER = /^(?:i|we|me|us|myself|ourselves)$/u;

/**
 * Whether an attestation carries the evidence its state requires.
 *
 * @remarks
 * Shared by the tool at record time and the validator at delivery time, so
 * an attestation that is rejected here never reaches the gate.
 */
export function attestationProblem(
  attestation: ActionAttestation,
  succeededTools: readonly string[]
): AttestationRejection | null {
  if (attestation.state === "completed") {
    return succeededTools.includes(attestation.toolName)
      ? null
      : "unproven-completion";
  }
  const owner = normalize(attestation.owner);
  if (
    PRONOUN_OWNER.test(owner) ||
    !normalize(attestation.sentence).includes(owner)
  ) {
    return "owner-not-named";
  }
  return null;
}

/**
 * Decides whether a terminal assistant message may be posted to Slack.
 *
 * @remarks
 * Pure: the channel hands it the message and the turn's gate state. Every
 * action statement in the message must be covered by one attestation whose
 * wording appears in that sentence, and that attestation must satisfy
 * {@link attestationProblem} against the tools that actually succeeded this
 * turn. The first failure wins; the message is never trimmed or rewritten.
 */
export function decideSlackDelivery(
  message: string,
  gate: Pick<SlackDeliveryGate, "attestations" | "succeededTools">
): SlackDeliveryDecision {
  for (const statement of findActionStatements(message)) {
    const sentence = normalize(statement);
    const attestation = gate.attestations.find((candidate) => {
      const attested = normalize(candidate.sentence);
      return (
        attested.length >= MIN_ATTESTED_LENGTH && sentence.includes(attested)
      );
    });
    if (attestation === undefined) {
      return { allowed: false, reason: "unattested-action" };
    }
    const problem = attestationProblem(attestation, gate.succeededTools);
    if (problem !== null) {
      return { allowed: false, reason: problem };
    }
  }
  return { allowed: true, message };
}

const emptyGate = (turnId: string): SlackDeliveryGate => ({
  attestations: [],
  succeededTools: [],
  turnId,
});

/**
 * Durable per-session gate state, scoped to one turn.
 *
 * @remarks
 * `defineState` does not reset between turns and the channel cannot override
 * `turn.started` without losing eve's typing defaults, so every write stamps
 * the turn id and {@link gateForTurn} discards whatever an earlier turn left.
 */
export const slackDeliveryGate = defineState<SlackDeliveryGate>(
  "foreman.slack-delivery-gate",
  () => emptyGate("")
);

export interface GateStore {
  get: () => SlackDeliveryGate;
  update: (fn: (current: SlackDeliveryGate) => SlackDeliveryGate) => void;
}

export const gateForTurn = (
  current: SlackDeliveryGate,
  turnId: string
): SlackDeliveryGate =>
  current.turnId === turnId ? current : emptyGate(turnId);

export const recordSucceededTool = (
  store: GateStore,
  turnId: string,
  toolName: string
): void => {
  store.update((current) => {
    const gate = gateForTurn(current, turnId);
    return { ...gate, succeededTools: [...gate.succeededTools, toolName] };
  });
};

export const recordAttestation = (
  store: GateStore,
  turnId: string,
  attestation: ActionAttestation
): void => {
  store.update((current) => {
    const gate = gateForTurn(current, turnId);
    return { ...gate, attestations: [...gate.attestations, attestation] };
  });
};

const EMPTY_DELIVERY_SENTINEL = "<eve-empty-delivery/>";

/**
 * The Slack event overrides that own the final-delivery boundary.
 *
 * @remarks
 * Replaces exactly two of eve's default handlers:
 *
 * - `action.result` is observe-only by default; here it records which tools
 *   succeeded this turn so a `completed` attestation can be checked against
 *   a real result rather than the model's word.
 * - `message.completed` is the post. Tool-call narration is dropped rather
 *   than buffered into the next typing status (the default's behaviour), a
 *   blank or empty-delivery message resets typing exactly as the default
 *   does, and every other terminal message goes through
 *   {@link decideSlackDelivery} when the session is intake-only. Rejections
 *   log the category and safe identifiers only, never the content.
 *
 * `store` is injected so tests can run the handlers without an eve context.
 */
export function slackDeliveryEvents(
  store: GateStore,
  isGated: (auth: SessionAuthContext | null) => boolean
): SlackChannelEvents {
  return {
    "action.result"(data, _channel, ctx) {
      const { result } = data;
      if (result.kind === "tool-result" && result.isError !== true) {
        recordSucceededTool(store, ctx.session.turn.id, result.toolName);
      }
    },
    async "message.completed"(data, channel, ctx) {
      if (data.finishReason === "tool-calls") {
        return;
      }
      const message = data.message?.trim() ?? "";
      if (message === "" || message === EMPTY_DELIVERY_SENTINEL) {
        await channel.thread.startTyping();
        return;
      }
      if (!isGated(ctx.session.auth.current)) {
        await channel.thread.post(data.message ?? "");
        return;
      }
      const turnId = ctx.session.turn.id;
      const decision = decideSlackDelivery(
        message,
        gateForTurn(store.get(), turnId)
      );
      if (decision.allowed) {
        await channel.thread.post(decision.message);
        return;
      }
      console.warn("Slack delivery rejected.", {
        reason: decision.reason,
        sessionId: ctx.session.id,
        turnId,
      });
      await channel.thread.post(SLACK_DELIVERY_FALLBACK);
    },
  };
}
