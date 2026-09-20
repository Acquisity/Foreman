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
const MAX_STATE_CHARS = 8000;

/** Below this, an explicit ask for a person was not what the customer wrote. */
const HUMAN_AGREEMENT = 0.5;
/** At or above this, the customer asked for a ticket. */
const TICKET_REQUEST = 0.5;

export const WIDGET_LANES = ["kb", "investigate", "human", "chat"] as const;
export type WidgetLane = (typeof WIDGET_LANES)[number];

/**
 * One customer message, kept apart from the conversation around it. Every
 * front-door stage judges `latest`; `turns` exist only to resolve a reference
 * such as "that" or "what next?". A bare string is a message with no context.
 */
export interface WidgetAsk {
  /** Help-center articles the previous reply cited: hints, validated before use. */
  activeArticles?: { title: string; url: string }[];
  /** The router judged `latest` a continuation of the previous reply. */
  followUp?: boolean;
  latest: string;
  turns?: { role: "customer" | "assistant"; text: string }[];
}

const CONTEXT_TURNS = 4;
const CONTEXT_TURN_CHARS = 400;

export const toAsk = (ask: string | WidgetAsk): WidgetAsk =>
  typeof ask === "string" ? { latest: ask } : ask;

/**
 * The ask as a model reads it: the latest message first and labelled, so a
 * length cap can never cut it, then a few bounded earlier turns.
 */
export function renderAsk(input: string | WidgetAsk): string {
  const ask = toAsk(input);
  const turns = (ask.turns ?? [])
    .filter((turn) => turn.text.trim())
    .slice(-CONTEXT_TURNS);
  if (turns.length === 0) {
    return ask.latest;
  }
  const context = turns
    .map(
      (turn) =>
        `${turn.role === "customer" ? "Customer" : "Support"}: ${turn.text.trim().slice(0, CONTEXT_TURN_CHARS)}`
    )
    .join("\n");
  return `LATEST CUSTOMER MESSAGE (the one to work on):\n${ask.latest}\n\nEARLIER TURNS (context only, to resolve what a word like "it" or "that" refers to):\n${context}`;
}

const QUESTIONS = {
  // Foreman can never act on an account, and the reply to a request to act is
  // always the same: a short apology and the steps. Knowing this up front keeps
  // such a message out of a minutes-long investigation it cannot benefit from.
  asks_for_action: {
    instructions:
      "The customer asks the assistant to CHANGE something on their behalf: to launch, enable, turn on, fix, cancel, add, connect, refund or set something up for them. Asking for a ticket to be opened or a bug to be reported is NOT this. Asking the assistant to check, look at, look up, verify or explain something about their account is NOT this, because reading is a question and not a change.",
    type: "noul",
  },
  asks_for_human: {
    instructions:
      "The customer explicitly asks to talk to a person, a human, an agent, or the support team.",
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
  is_unclear: {
    instructions:
      "Taking the earlier conversation into account, the customer's latest message still does not say which feature, page or thing it is about, or what actually went wrong, so a careful support person would have to ask what they mean before they could help. A short follow-up whose subject is clear from the earlier turns is NOT this.",
    type: "noul",
  },
  lane: {
    criteria: {
      // Without this the router had to file a plain "thank you" under one of the
      // other lanes, and with an account conversation as context it chose
      // investigate: minutes of work to answer nothing.
      chat: "The customer's latest message asks nothing and needs nothing looked up: a thank you, a reaction, an acknowledgement, a greeting, a goodbye or small talk. Judge the latest message itself, even when the earlier conversation was about their account.",
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
} as const;

const responseSchema = z.object({
  answers: z.object({
    asks_for_action: z.object({ noul: z.number().min(0).max(1) }).optional(),
    asks_for_human: z.object({ noul: z.number().min(0).max(1) }),
    asks_for_ticket: z.object({ noul: z.number().min(0).max(1) }).optional(),
    asks_own_data: z.object({ noul: z.number().min(0).max(1) }),
    depends_on_previous: z
      .object({ noul: z.number().min(0).max(1) })
      .optional(),
    is_unclear: z.object({ noul: z.number().min(0).max(1) }).optional(),
    lane: z.object({
      choice: z.enum(WIDGET_LANES),
      confidence: z.number().min(0).max(1).optional(),
      probabilities: z.record(z.string(), z.number()).optional(),
    }),
  }),
});

export interface WidgetRoute {
  asksForAction: number;
  asksForHuman: number;
  asksOwnData: number;
  confidence: number;
  /** How likely the latest message only continues the previous reply. */
  followUp?: number;
  /** How likely the help center is the right lane, even when another lane won. */
  kbScore: number;
  lane: WidgetLane;
  source: "jev" | "fallback";
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
        state: renderAsk(ask).slice(0, MAX_STATE_CHARS),
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
    // A ticket can only be filed from an investigation, so a request for one is
    // never a change to apologise for, a help-center question or a handoff.
    const wantsTicket =
      (answers.asks_for_ticket?.noul ?? 0) >= TICKET_REQUEST &&
      answers.asks_for_human.noul < HUMAN_AGREEMENT;
    if (wantsTicket) {
      return {
        asksForAction: 0,
        asksForHuman: answers.asks_for_human.noul,
        asksOwnData: answers.asks_own_data.noul,
        confidence,
        kbScore: 0,
        lane: "investigate",
        source: "jev",
        unclear: 0,
      };
    }
    return {
      asksForAction: answers.asks_for_action?.noul ?? 0,
      asksForHuman: answers.asks_for_human.noul,
      asksOwnData: answers.asks_own_data.noul,
      confidence,
      followUp: answers.depends_on_previous?.noul ?? 0,
      // Jev may omit the per-lane probabilities; the winner's confidence stands in.
      kbScore:
        answers.lane.probabilities?.kb ??
        (answers.lane.choice === "kb" ? confidence : 0),
      // The lane choice and the direct question must agree before a handoff: the
      // human lane skips the investigation, so a wrong guess costs the customer an answer.
      lane:
        answers.lane.choice === "human" &&
        answers.asks_for_human.noul < HUMAN_AGREEMENT
          ? "investigate"
          : answers.lane.choice,
      source: "jev",
      unclear: answers.is_unclear?.noul ?? 0,
    };
  } catch {
    return FALLBACK;
  }
}

export function logRouteDecision(
  fields: { conversationId: string; runId: string },
  route: WidgetRoute
) {
  logOpsEvent("widget.router.decision", {
    conversationId: fields.conversationId,
    decision: route.lane,
    message: `source=${route.source} confidence=${route.confidence.toFixed(2)} kb=${route.kbScore.toFixed(2)} ownData=${route.asksOwnData.toFixed(2)} human=${route.asksForHuman.toFixed(2)} action=${route.asksForAction.toFixed(2)} unclear=${(route.unclear ?? 0).toFixed(2)} followUp=${(route.followUp ?? 0).toFixed(2)}`,
    runId: fields.runId,
  });
}
