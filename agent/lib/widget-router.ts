import { z } from "zod";
import { logOpsEvent } from "./ops-log.js";
import {
  askJev,
  FRONT_DOOR_JEV_MS,
  fallbackReason,
  JEV_URL,
  jevKey,
} from "./widget-next-action.js";

/**
 * Front-door intent router for the support widget, backed by TypeSafe's Jev
 * (a System One model: typed, calibrated decisions, no generated text).
 *
 * @remarks
 * Runs on the raw customer message. It never calls tools, never sees account
 * data, and never writes the reply; it only scores what the message is. It no
 * longer picks a lane (ENG-14841): only the customer's explicit "Investigate my
 * workspace" (`mode: "investigate"`), a teammate or an owner's recording starts
 * an investigation, so a message without one always ends at the front door in a
 * fixed refund or ticket redirect, the one help-center writer or, when the
 * customer asks for a person, a handoff. A missing key or a Jev failure scores
 * everything zero, which is a help-center answer. Inside an investigation the
 * same call decides whether the app offers its screen recording button.
 */

const TYPESAFE_MODEL = "jev-latest";
const ROUTER_TIMEOUT_MS = 5000;
// The accepted question (4,000) with up to three screenshot readings (1,500
// each) plus the full history budget and its labels (16,230 at most) fit inside this, so the cap
// never cuts anything; the latest message leads regardless.
const MAX_STATE_CHARS = 17_000;

/** Below this, an explicit ask for a person was not what the customer wrote. */
export const HUMAN_REQUEST_SCORE = 0.8;
/** At or above this, the customer asked for a ticket. */
const TICKET_REQUEST = 0.5;
/** At or above this, the customer asked for a refund. */
const REFUND_REQUEST = 0.5;
/** At or above this, the customer is reporting a bug, and the app asks for a screen recording. */
const BUG_REPORT = 0.7;
/** At or above this, the customer asks or offers to send a screen recording, and the app offers one. */
const RECORDING_REQUEST = 0.5;

/**
 * One customer message, kept apart from the conversation around it. Every
 * front-door stage judges `latest`; `turns` exist only to resolve a reference
 * such as "that" or "what next?". A bare string is a message with no context.
 */
export interface WidgetAsk {
  /** Help-center articles the previous reply cited: hints, validated before use. */
  activeArticles?: { title: string; url: string }[];
  /**
   * Short-lived links to those screenshots themselves. The help-center lane
   * looks at them: from a reading alone it answered a warning on the screen
   * instead of the customer's next step (13 of 21 real follow-ups right, 21 of
   * 21 with the image). Stages that only read text keep using `screenshots`.
   */
  images?: string[];
  latest: string;
  /**
   * Whether the app shows its screen recording button under this reply: the same
   * decision that sets `request_recording`. Absent until that decision is made.
   */
  recordingOffered?: boolean;
  /**
   * What an image model read from screenshots attached to `latest`. Kept apart
   * from the customer's words: joined into them, a reading of another page made
   * Jev judge a matching article "not covered" (0.58, against 1.00 without it).
   */
  screenshots?: string[];
  turns?: { role: "customer" | "assistant"; text: string }[];
}

export interface ContextBudget {
  /** All earlier turns together. The latest message is never counted against this. */
  chars: number;
  turnChars: number;
  turns: number;
}
/**
 * What the router, the investigator and the selector all read. Acquisity sends
 * at most the last 8 customer-visible messages at 2,000 characters each, so this
 * keeps a whole turn and as many recent ones as fit.
 */
export const DECISION_CONTEXT: ContextBudget = {
  chars: 7000,
  turnChars: 2000,
  turns: 12,
};

export const toAsk = (ask: string | WidgetAsk): WidgetAsk =>
  typeof ask === "string" ? { latest: ask } : ask;

/**
 * One conversation format for every reader: the latest message first, labelled
 * and whole, then the earlier turns, newest kept first within their own budget,
 * with every cut and omission marked. History can never crowd out the question.
 */
export function renderConversation(
  latest: string,
  history: WidgetAsk["turns"] = [],
  budget: ContextBudget = DECISION_CONTEXT,
  screenshots: string[] = []
): string {
  const shots = screenshots.length
    ? `\n\nSCREENSHOTS ATTACHED TO THE LATEST MESSAGE (what the customer's screen showed, as read by an image model: context for the message, not part of what they wrote):\n${screenshots.join("\n\n")}`
    : "";
  const context = recentTurns(history, budget);
  if (context.length === 0) {
    return shots
      ? `LATEST CUSTOMER MESSAGE (the one to work on):\n${latest}${shots}`
      : latest;
  }
  return `LATEST CUSTOMER MESSAGE (the one to work on):\n${latest}${shots}\n\nEARLIER TURNS (context only: they resolve what "it", "that" or a follow-up refers to while the subject is the same, and do not carry over once the latest message changes subject. Only recent messages are shown and some may be cut, so a detail missing here is not proof the customer never gave it):\n${context.join("\n")}`;
}

/** The earlier turns, oldest first, newest kept first within the budget, with every cut and omission marked. */
export function recentTurns(
  history: WidgetAsk["turns"] = [],
  budget: ContextBudget = DECISION_CONTEXT
): string[] {
  const turns = history.filter((turn) => turn.text.trim());
  const kept: string[] = [];
  let left = budget.chars;
  for (const turn of turns.slice(-budget.turns).reverse()) {
    const text = turn.text.trim();
    const shown =
      text.length > budget.turnChars
        ? `${text.slice(0, budget.turnChars)} [message cut here]`
        : text;
    // The marker is ours, so it is not charged to the customer's budget.
    const cost = Math.min(text.length, budget.turnChars);
    if (cost > left) {
      break;
    }
    left -= cost;
    kept.unshift(
      `${turn.role === "customer" ? "Customer" : "Support"}: ${shown}`
    );
  }
  const omitted = turns.length - kept.length;
  return [
    ...(omitted
      ? [`[${omitted} older message${omitted === 1 ? "" : "s"} not shown]`]
      : []),
    ...kept,
  ];
}

export const RECORDING_RULE =
  "They cannot attach video or other files here. recordingOffered says whether the app shows a small Record my screen button at the bottom of your reply. When it is true, mention the button only when a recording would actually help pin the problem down, such as when they ask or offer to send one or when their words do not show what went wrong, and then in a few words; otherwise say nothing about it, and never repeat a mention Support already made earlier in the conversation unless they ask or offer to send a recording again. This recording guidance takes precedence over general rules against repetition. You may still ask for the one detail you need. When it is true, never send them anywhere else to record, send or report the problem, such as another recording tool, a feedback form, email or another chat button, even when an article says to: they are already in the support chat, and the Record my screen button on your reply is the way to send it. When it is false, never mention a recording option or button, and never say a recording is impossible.";

/** The ask as the router reads it. */
export const renderAsk = (
  input: string | WidgetAsk,
  budget: ContextBudget = DECISION_CONTEXT
): string => {
  const ask = toAsk(input);
  return renderConversation(ask.latest, ask.turns, budget, ask.screenshots);
};

// Foreman can never act on an account, so an investigation's reply may say it
// cannot make changes only when the customer asked for one.
const ASKS_FOR_ACTION = {
  instructions:
    "The customer asks the assistant to CHANGE something on their behalf: to launch, enable, turn on, fix, cancel, add, connect or set something up for them. Asking for a ticket to be opened, a bug to be reported or a refund is NOT this. Asking the assistant to check, look at, look up, verify or explain something about their account is NOT this, because reading is a question and not a change.",
  type: "noul",
} as const;

const QUESTIONS = {
  asks_for_human: {
    instructions:
      "The customer explicitly requests a conversation with a human support representative. Asking where to find or how to use a named product feature (such as Niche Researcher or AI SDR) is not a request for a person.",
    type: "noul",
  },
  // A refund needs a look at billing and a ticket, which only an investigation
  // can do: members are pointed to their owner, owners to the toggle.
  asks_for_refund: {
    instructions:
      "The customer asks for a refund, their money back or a charge to be reversed, or the latest message continues such a request from the earlier turns, for example by saying which charge it was or why they want it back. Asking how refunds work in general, or what a charge was for, without asking for money back is NOT this.",
    type: "noul",
  },
  // Filing a ticket is the one thing Foreman can do for a customer, and only an
  // investigation does it, so an owner asking for one is pointed to the toggle.
  asks_for_ticket: {
    instructions:
      "The customer asks for a ticket to be opened, filed, raised or escalated to engineering or the technical team, or asks to report a bug.",
    type: "noul",
  },
  // Asked in the same request, so it costs nothing. Like reports_bug, it only
  // decides whether an investigation offers the app's recording button.
  // "can i send a screen reco0rding" slipped past a pattern and got a Loom tip.
  offers_recording: {
    instructions:
      "The customer asks whether they can send, share or show a screen recording or video of their problem, or offers to record one. A question about how to record something inside the product, or a problem with a recording feature, is NOT this.",
    type: "noul",
  },
  // Asked in the same request, so it costs nothing. It only decides whether an
  // investigation offers a screen recording next to its reply.
  reports_bug: {
    instructions:
      "The customer reports something in the product not working as it should: an error message, a page or button that does nothing or breaks, something that fails to load, save, send or generate, or a result that is wrong. A how-to question, a billing or refund request, a request for a change, or a message that only answers a question Support just asked is NOT this.",
    type: "noul",
  },
} as const;

const responseSchema = z.object({
  answers: z.object({
    asks_for_human: z.object({ noul: z.number().min(0).max(1) }),
    asks_for_refund: z.object({ noul: z.number().min(0).max(1) }).optional(),
    asks_for_ticket: z.object({ noul: z.number().min(0).max(1) }).optional(),
    offers_recording: z.object({ noul: z.number().min(0).max(1) }).optional(),
    reports_bug: z.object({ noul: z.number().min(0).max(1) }).optional(),
  }),
});

export interface WidgetRoute {
  asksForHuman: number;
  /** The customer is reporting a bug, so an investigation offers a screen recording. */
  bug?: boolean;
  /** Why Jev gave no route, for the log: a fixed code and the time it took. */
  failure?: string;
  /** The customer asks or offers to send a screen recording, so an investigation offers one. */
  recording?: boolean;
  /** The customer asked for a refund, which only an investigation can file. */
  refund?: boolean;
  source: "jev" | "fallback";
  /** The customer asked for a ticket, which only an investigation can file. */
  ticket?: boolean;
}

/** Everything scored zero: a help-center answer, never an investigation or a handoff. */
const FALLBACK: WidgetRoute = { asksForHuman: 0, source: "fallback" };

type FetchLike = (
  input: string,
  init: {
    body: string;
    headers: Record<string, string>;
    method: "POST";
    signal: AbortSignal;
  }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export async function routeWidgetMessage(
  ask: string | WidgetAsk,
  opts?: {
    apiKey?: string;
    fetch?: FetchLike;
    signal?: AbortSignal;
  }
): Promise<WidgetRoute> {
  const apiKey = opts?.apiKey ?? jevKey();
  if (!apiKey) {
    return FALLBACK;
  }
  const startedAt = Date.now();
  try {
    const response = await askJev(
      QUESTIONS,
      renderAsk(ask, DECISION_CONTEXT).slice(0, MAX_STATE_CHARS),
      apiKey,
      {
        fetch: opts?.fetch,
        signal: opts?.signal,
        timeoutMs: FRONT_DOOR_JEV_MS,
      }
    );
    const { answers } = responseSchema.parse(response);
    const flag = (score: number | undefined, bar: number) =>
      (score ?? 0) >= bar;
    return {
      asksForHuman: answers.asks_for_human.noul,
      source: "jev",
      ...(flag(answers.reports_bug?.noul, BUG_REPORT) ? { bug: true } : {}),
      ...(flag(answers.offers_recording?.noul, RECORDING_REQUEST)
        ? { recording: true }
        : {}),
      ...(flag(answers.asks_for_refund?.noul, REFUND_REQUEST)
        ? { refund: true }
        : {}),
      ...(flag(answers.asks_for_ticket?.noul, TICKET_REQUEST)
        ? { ticket: true }
        : {}),
    };
  } catch (error) {
    return {
      ...FALLBACK,
      failure: `reason=${fallbackReason(error)} ms=${Date.now() - startedAt}`,
    };
  }
}

/** At or above this, the customer asked for a change on their account (the front door's action bar). */
const CHANGE_REQUEST = 0.8;
const changeSchema = z.object({
  answers: z.object({ asks_for_action: z.object({ noul: z.number() }) }),
});

/**
 * Jev's one question at the finish of an investigation: did the customer ask
 * us to change something for them? Only then may the reply say it cannot make
 * changes. Any failure is "no", so the reply never says it unasked.
 */
export async function asksForChange(
  conversation: string,
  opts?: { apiKey?: string; fetch?: FetchLike; signal?: AbortSignal }
): Promise<boolean> {
  const apiKey = opts?.apiKey ?? jevKey();
  if (!apiKey) {
    return false;
  }
  const doFetch = (opts?.fetch ?? fetch) as unknown as FetchLike;
  const timeout = AbortSignal.timeout(ROUTER_TIMEOUT_MS);
  try {
    const response = await doFetch(JEV_URL, {
      body: JSON.stringify({
        model: TYPESAFE_MODEL,
        questions: { asks_for_action: ASKS_FOR_ACTION },
        state: conversation.slice(0, MAX_STATE_CHARS),
      }),
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    if (!response.ok) {
      return false;
    }
    const { answers } = changeSchema.parse(await response.json());
    return answers.asks_for_action.noul >= CHANGE_REQUEST;
  } catch {
    return false;
  }
}

const RECORDING_OFFER =
  /\bscreen[\s-]?(?:record|cast|capture)|\brecord(?:ing)?\s+(?:of\s+)?(?:my|the)\s+screen|\b(?:send|share|upload|attach|record|show)\b[^.?!]{0,40}\b(?:video|loom|jam)\b/i;

/** A cheap extra trigger beside Jev's offers_recording, which is what catches typos and rewordings. */
export const offersRecording = (message: string) =>
  RECORDING_OFFER.test(message.slice(0, 4000));

export function logRouteDecision(
  fields: { conversationId: string; runId: string },
  route: WidgetRoute
) {
  logOpsEvent("widget.router.decision", {
    conversationId: fields.conversationId,
    decision: route.source,
    message: `human=${route.asksForHuman.toFixed(2)}${route.refund ? " refund" : ""}${route.ticket ? " ticket" : ""}${route.bug ? " bug" : ""}${route.recording ? " recording" : ""}${route.failure ? ` ${route.failure}` : ""}`,
    runId: fields.runId,
  });
}
