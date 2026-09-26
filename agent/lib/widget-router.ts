import { z } from "zod";
import { logOpsEvent } from "./ops-log.js";

/**
 * Front-door intent router for the support widget, backed by TypeSafe's Jev
 * (a System One model: typed, calibrated decisions, no generated text).
 *
 * @remarks
 * Runs on the raw customer message before the investigator session starts.
 * It never calls tools, never sees account data, and never writes the reply;
 * it only says which lane the message belongs in and how sure it is. Any
 * failure, including a missing key, falls open to `investigate`, which is
 * the investigation pipeline, so removing `TYPESAFE_API_KEY` restores the old
 * single-lane behavior exactly. A confident `kb` decision is acted on by the
 * knowledge-base lane (`widget-kb.ts`); `human` hands off to a teammate at once, without an investigation.
 */

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_MODEL = "jev-latest";
const ROUTER_TIMEOUT_MS = 5000;
// The accepted question (4,000) with up to three screenshot readings (1,500
// each) plus the full history budget and its labels fit inside this, so the cap
// never cuts anything; the latest message leads regardless.
const MAX_STATE_CHARS = 16_000;

/** Below this, an explicit ask for a person was not what the customer wrote. */
export const HUMAN_REQUEST_SCORE = 0.8;
/** At or above this, the customer asked for a ticket. */
const TICKET_REQUEST = 0.5;
/** At or above this, the customer asked for a refund. */
const REFUND_REQUEST = 0.5;
/** At or above this, the customer is reporting a bug, and the app asks for a screen recording. */
const BUG_REPORT = 0.7;

export const WIDGET_LANES = ["kb", "investigate", "human", "chat"] as const;
export type WidgetLane = (typeof WIDGET_LANES)[number];

/**
 * One customer message, kept apart from the conversation around it. Every
 * front-door stage judges `latest`; `turns` exist only to resolve a reference
 * such as "that" or "what next?". A bare string is a message with no context.
 */
export interface WidgetAsk {
  /**
   * The router leaned towards an account lookup. The help-center lane then
   * answers only what an article fully resolves, and says so when the message
   * is an incomplete fragment, instead of answering an account question generically.
   */
  accountLikely?: boolean;
  /** Help-center articles the previous reply cited: hints, validated before use. */
  activeArticles?: { title: string; url: string }[];
  /**
   * Help-center mode (not an owner or admin): nothing will look at this
   * account, so an ask for a look is answered from the articles, with a plain
   * "not something I can do" first, instead of stepping aside.
   */
  cannotLook?: boolean;
  /** The router judged `latest` a continuation of the previous reply. */
  followUp?: boolean;
  latest: string;
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
/** A one-line front-door reply needs only what "it" or "that" points at. */
const REPLY_CONTEXT: ContextBudget = { chars: 1600, turnChars: 400, turns: 4 };
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
  const turns = history.filter((turn) => turn.text.trim());
  const shots = screenshots.length
    ? `\n\nSCREENSHOTS ATTACHED TO THE LATEST MESSAGE (what the customer's screen showed, as read by an image model: context for the message, not part of what they wrote):\n${screenshots.join("\n\n")}`
    : "";
  if (turns.length === 0) {
    return shots
      ? `LATEST CUSTOMER MESSAGE (the one to work on):\n${latest}${shots}`
      : latest;
  }
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
  const context = [
    ...(omitted
      ? [`[${omitted} older message${omitted === 1 ? "" : "s"} not shown]`]
      : []),
    ...kept,
  ].join("\n");
  return `LATEST CUSTOMER MESSAGE (the one to work on):\n${latest}${shots}\n\nEARLIER TURNS (context only: they resolve what "it", "that" or a follow-up refers to while the subject is the same, and do not carry over once the latest message changes subject. Only recent messages are shown and some may be cut, so a detail missing here is not proof the customer never gave it):\n${context}`;
}

/** The ask as a front-door reply reads it; the router passes the full decision budget. */
export const renderAsk = (
  input: string | WidgetAsk,
  budget: ContextBudget = REPLY_CONTEXT
): string => {
  const ask = toAsk(input);
  return renderConversation(ask.latest, ask.turns, budget, ask.screenshots);
};

const QUESTIONS = {
  // Foreman can never act on an account, and the reply to a request to act is
  // always the same: a short apology and the steps. Knowing this up front keeps
  // such a message out of a minutes-long investigation it cannot benefit from.
  asks_for_action: {
    instructions:
      "The customer asks the assistant to CHANGE something on their behalf: to launch, enable, turn on, fix, cancel, add, connect or set something up for them. Asking for a ticket to be opened, a bug to be reported or a refund is NOT this. Asking the assistant to check, look at, look up, verify or explain something about their account is NOT this, because reading is a question and not a change.",
    type: "noul",
  },
  asks_for_human: {
    instructions:
      "The customer explicitly requests a conversation with a human support representative. Asking where to find or how to use a named product feature (such as Niche Researcher or AI SDR) is not a request for a person.",
    type: "noul",
  },
  // A refund is never a help-center answer: which charge and why is asked for,
  // billing is read, and the request is filed for the billing team.
  asks_for_refund: {
    instructions:
      "The customer asks for a refund, their money back or a charge to be reversed, or the latest message continues such a request from the earlier turns, for example by saying which charge it was or why they want it back. Asking how refunds work in general, or what a charge was for, without asking for money back is NOT this.",
    type: "noul",
  },
  // Filing a ticket is the one thing Foreman can do for a customer. "can you open
  // up a tech ticket for me" scored asks_for_action 0.86 and got the fast lane's
  // "I am not able to open tickets"; an earlier one was handed to a person.
  asks_for_ticket: {
    instructions:
      "The customer asks for a ticket to be opened, filed, raised or escalated to engineering or the technical team, or asks to report a bug.",
    type: "noul",
  },
  asks_own_data: {
    instructions:
      "The customer is asking about their own account, workspace, campaigns, billing, or activity, rather than how the product works in general.",
    type: "noul",
  },
  // "what about the limit?" and "nothing works!!" were investigated for two to
  // three minutes before anyone asked what the customer meant.
  // A terse follow-up ("okay, and after that?") has no subject of its own, so
  // retrieval on it alone drifts to another article. This is what keeps the
  // article the previous reply cited; a named new subject scores low and resets it.
  depends_on_previous: {
    instructions:
      "The customer's latest message only makes sense as a continuation of Support's previous answer: it asks for the next step, more detail, a part, a repeat or a clarification of what was just explained, and names no product, feature or subject of its own. A message that names a new product, feature, page or subject is NOT this, however short it is.",
    type: "noul",
  },
  // Asked in the same request as the rest, so it costs no extra call. It is not
  // depends_on_previous: "and what about campaign B?" continues the conversation
  // and still needs a look.
  explains_previous: {
    instructions:
      "The customer's latest message only asks what Support's previous answer means: to explain, confirm, reword or spell out the implication of something that answer already said. It can be answered from that answer's own words with nothing looked up. A request to check again, to check something else, for the current status, or about anything the previous answer did not cover is NOT this.",
    type: "noul",
  },
  is_unclear: {
    instructions:
      "Taking the earlier conversation into account, the customer's latest message still does not say which feature, page or thing it is about, or what actually went wrong, so a careful support person would have to ask what they mean before they could even start looking. A short follow-up whose subject is clear from the earlier turns is NOT this, and neither is a message whose missing detail an earlier turn already gave (a campaign, inbox, website or choice named there) or that a look at the customer's own workspace could find or narrow down. An identifier from an earlier subject does not apply once the latest message has changed subject.",
    type: "noul",
  },
  lane: {
    criteria: {
      // Without this the router had to file a plain "thank you" under one of the
      // other lanes, and with an account conversation as context it chose
      // investigate: minutes of work to answer nothing.
      chat: "The customer's latest message asks nothing and needs nothing looked up: a thank you, a reaction, an acknowledgement, a greeting, a goodbye or small talk. Judge the latest message itself, even when the earlier conversation was about their account. A message that answers a question Support just asked, such as confirming a name, a date or a detail ('it is the right name', 'yes, that one'), is NOT this: it continues that request.",
      // "can you open up a ticket for me" was filed here at 0.96 and handed off
      // with nothing looked up and no ticket filed.
      human:
        "The customer explicitly asks for a person, a human, an agent, or the support team. Asking to open, file or raise a ticket, or to report a bug, is NOT this.",
      // "where are my campaigns" read as an account lookup at 0.94: "my" alone
      // says nothing about whether the answer needs the customer's data.
      investigate:
        "A question that can only be answered by looking up this customer's actual data or current status: their numbers, their balance, a specific charge, or why something of theirs is failing right now. A request to open, file or raise a ticket, or to report a bug, is also this kind.",
      kb: "A how-to or product question that a help-center article can answer: how to do something, where to find a page or setting in the app, what a feature or page is for, or what a term means. It is still this kind when phrased with 'my', as in 'where are my campaigns' or 'how do I change my sender name'.",
    },
    instructions: "Which kind of help does the customer's message need?",
    type: "choice",
  },
  // Asked in the same request, so it costs nothing. It only decides whether the
  // app offers a screen recording next to the reply; the lanes ignore it.
  reports_bug: {
    instructions:
      "The customer reports something in the product not working as it should: an error message, a page or button that does nothing or breaks, something that fails to load, save, send or generate, or a result that is wrong. A how-to question, a billing or refund request, a request for a change, or a message that only answers a question Support just asked is NOT this.",
    type: "noul",
  },
} as const;

const responseSchema = z.object({
  answers: z.object({
    asks_for_action: z.object({ noul: z.number().min(0).max(1) }).optional(),
    asks_for_human: z.object({ noul: z.number().min(0).max(1) }),
    asks_for_refund: z.object({ noul: z.number().min(0).max(1) }).optional(),
    asks_for_ticket: z.object({ noul: z.number().min(0).max(1) }).optional(),
    asks_own_data: z.object({ noul: z.number().min(0).max(1) }),
    depends_on_previous: z
      .object({ noul: z.number().min(0).max(1) })
      .optional(),
    explains_previous: z.object({ noul: z.number().min(0).max(1) }).optional(),
    is_unclear: z.object({ noul: z.number().min(0).max(1) }).optional(),
    lane: z.object({
      choice: z.enum(WIDGET_LANES),
      confidence: z.number().min(0).max(1).optional(),
      probabilities: z.record(z.string(), z.number()).optional(),
    }),
    reports_bug: z.object({ noul: z.number().min(0).max(1) }).optional(),
  }),
});

function supportedLane(
  answers: z.infer<typeof responseSchema>["answers"]
): WidgetLane {
  if (
    answers.lane.choice !== "human" ||
    answers.asks_for_human.noul >= HUMAN_REQUEST_SCORE
  ) {
    return answers.lane.choice;
  }
  return (answers.lane.probabilities?.kb ?? 0) >
    (answers.lane.probabilities?.investigate ?? 0)
    ? "kb"
    : "investigate";
}
export interface WidgetRoute {
  asksForAction: number;
  asksForHuman: number;
  asksOwnData: number;
  /** The customer is reporting a bug, so the app offers a screen recording. */
  bug?: boolean;
  confidence: number;
  /** How likely the latest message only asks what the previous reply meant. */
  explainsPrevious?: number;
  /** How likely the latest message only continues the previous reply. */
  followUp?: number;
  /** How likely the help center is the right lane, even when another lane won. */
  kbScore: number;
  lane: WidgetLane;
  /** The customer asked for a refund, which an investigation files as a ticket. */
  refund?: boolean;
  source: "jev" | "fallback";
  /** The customer asked for a ticket, which only an investigation can file. */
  ticket?: boolean;
  /** How likely the message cannot be helped without first asking what it means. */
  unclear?: number;
}

const FALLBACK: WidgetRoute = {
  asksForAction: 0,
  asksForHuman: 0,
  asksOwnData: 0,
  confidence: 0,
  kbScore: 0,
  lane: "investigate",
  source: "fallback",
};

type FetchLike = (
  input: string,
  init: {
    body: string;
    headers: Record<string, string>;
    method: "POST";
    signal: AbortSignal;
  }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * A ticket can only be filed from an investigation, so a request for one is
 * never a change to apologise for, a help-center question or a handoff. A refund
 * request ends in a ticket, so it takes the same way in. An explicit ask for a
 * person still wins.
 */
function ticketRoute(
  answers: z.infer<typeof responseSchema>["answers"],
  confidence: number
): WidgetRoute | null {
  if (answers.asks_for_human.noul >= HUMAN_REQUEST_SCORE) {
    return null;
  }
  const refund = (answers.asks_for_refund?.noul ?? 0) >= REFUND_REQUEST;
  if (!(refund || (answers.asks_for_ticket?.noul ?? 0) >= TICKET_REQUEST)) {
    return null;
  }
  return {
    asksForAction: 0,
    asksForHuman: answers.asks_for_human.noul,
    asksOwnData: answers.asks_own_data.noul,
    confidence,
    kbScore: 0,
    lane: "investigate",
    ...(refund ? { refund } : {}),
    source: "jev",
    ticket: true,
    unclear: 0,
  };
}

export async function routeWidgetMessage(
  ask: string | WidgetAsk,
  opts?: {
    apiKey?: string;
    fetch?: FetchLike;
    signal?: AbortSignal;
  }
): Promise<WidgetRoute> {
  const apiKey = opts?.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    return FALLBACK;
  }
  const doFetch = (opts?.fetch ?? fetch) as unknown as FetchLike;
  const signal = opts?.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(ROUTER_TIMEOUT_MS)])
    : AbortSignal.timeout(ROUTER_TIMEOUT_MS);
  try {
    const response = await doFetch(TYPESAFE_URL, {
      body: JSON.stringify({
        model: TYPESAFE_MODEL,
        questions: QUESTIONS,
        state: renderAsk(ask, DECISION_CONTEXT).slice(0, MAX_STATE_CHARS),
      }),
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal,
    });
    if (!response.ok) {
      return FALLBACK;
    }
    const { answers } = responseSchema.parse(await response.json());
    const confidence = answers.lane.confidence ?? 0;
    const bug = (answers.reports_bug?.noul ?? 0) >= BUG_REPORT;
    const routed: WidgetRoute = ticketRoute(answers, confidence) ?? {
      asksForAction: answers.asks_for_action?.noul ?? 0,
      asksForHuman: answers.asks_for_human.noul,
      asksOwnData: answers.asks_own_data.noul,
      confidence,
      explainsPrevious: answers.explains_previous?.noul ?? 0,
      followUp: answers.depends_on_previous?.noul ?? 0,
      // Jev may omit the per-lane probabilities; the winner's confidence stands in.
      kbScore:
        answers.lane.probabilities?.kb ??
        (answers.lane.choice === "kb" ? confidence : 0),
      // The lane choice and the direct question must agree before a handoff: the
      // human lane skips the investigation, so a wrong guess costs the customer an answer.
      lane: supportedLane(answers),
      source: "jev",
      unclear: answers.is_unclear?.noul ?? 0,
    };
    return bug ? { ...routed, bug } : routed;
  } catch {
    return FALLBACK;
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
  const apiKey = opts?.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    return false;
  }
  const doFetch = (opts?.fetch ?? fetch) as unknown as FetchLike;
  const timeout = AbortSignal.timeout(ROUTER_TIMEOUT_MS);
  try {
    const response = await doFetch(TYPESAFE_URL, {
      body: JSON.stringify({
        model: TYPESAFE_MODEL,
        questions: { asks_for_action: QUESTIONS.asks_for_action },
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

/** The customer asks or offers to send a screen recording, so the app offers one whatever the bug score. */
export const offersRecording = (message: string) =>
  RECORDING_OFFER.test(message.slice(0, 4000));

export function logRouteDecision(
  fields: { conversationId: string; runId: string },
  route: WidgetRoute
) {
  logOpsEvent("widget.router.decision", {
    conversationId: fields.conversationId,
    decision: route.lane,
    message: `source=${route.source} confidence=${route.confidence.toFixed(2)} kb=${route.kbScore.toFixed(2)} ownData=${route.asksOwnData.toFixed(2)} human=${route.asksForHuman.toFixed(2)} action=${route.asksForAction.toFixed(2)} unclear=${(route.unclear ?? 0).toFixed(2)} followUp=${(route.followUp ?? 0).toFixed(2)} explain=${(route.explainsPrevious ?? 0).toFixed(2)}${route.refund ? " refund" : ""}${route.bug ? " bug" : ""}`,
    runId: fields.runId,
  });
}
