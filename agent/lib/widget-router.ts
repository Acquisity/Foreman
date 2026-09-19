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
 * knowledge-base lane (`widget-kb.ts`); `human` is logged and still investigated.
 */

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_MODEL = "jev-latest";
const ROUTER_TIMEOUT_MS = 5000;
const MAX_STATE_CHARS = 8000;

export const WIDGET_LANES = ["kb", "investigate", "human", "chat"] as const;
export type WidgetLane = (typeof WIDGET_LANES)[number];

const QUESTIONS = {
  // Foreman can never act on an account, and the reply to a request to act is
  // always the same: a short apology and the steps. Knowing this up front keeps
  // such a message out of a minutes-long investigation it cannot benefit from.
  asks_for_action: {
    instructions:
      "The customer asks the assistant to CHANGE something on their behalf: to launch, enable, turn on, fix, cancel, add, connect, refund or set something up for them. Asking the assistant to check, look at, look up, verify or explain something about their account is NOT this, because reading is a question and not a change.",
    type: "noul",
  },
  asks_for_human: {
    instructions:
      "The customer explicitly asks to talk to a person, a human, an agent, or the support team.",
    type: "noul",
  },
  asks_own_data: {
    instructions:
      "The customer is asking about their own account, workspace, campaigns, billing, or activity, rather than how the product works in general.",
    type: "noul",
  },
  lane: {
    criteria: {
      // Without this the router had to file a plain "thank you" under one of the
      // other lanes, and with an account conversation as context it chose
      // investigate: minutes of work to answer nothing.
      chat: "The customer's latest message asks nothing and needs nothing looked up: a thank you, a reaction, an acknowledgement, a greeting, a goodbye or small talk. Judge the latest message itself, even when the earlier conversation was about their account.",
      human:
        "The customer explicitly asks for a person, a human, an agent, or the support team.",
      investigate:
        "A question about this customer's own account, data, campaigns, billing, or something not working for them, which needs their account checked.",
      kb: "A general how-to or product question that a public help-center article can answer without looking at this customer's account.",
    },
    instructions: "Which kind of help does the customer's message need?",
    type: "choice",
  },
} as const;

const responseSchema = z.object({
  answers: z.object({
    asks_for_action: z.object({ noul: z.number().min(0).max(1) }).optional(),
    asks_for_human: z.object({ noul: z.number().min(0).max(1) }),
    asks_own_data: z.object({ noul: z.number().min(0).max(1) }),
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
  lane: WidgetLane;
  source: "jev" | "fallback";
}

const FALLBACK: WidgetRoute = {
  asksForAction: 0,
  asksForHuman: 0,
  asksOwnData: 0,
  confidence: 0,
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
  question: string,
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
        // ponytail: routes on the latest message alone; add prior turns if follow-ups like "yes please" misroute.
        state: question.slice(0, MAX_STATE_CHARS),
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
    return {
      asksForAction: answers.asks_for_action?.noul ?? 0,
      asksForHuman: answers.asks_for_human.noul,
      asksOwnData: answers.asks_own_data.noul,
      confidence: answers.lane.confidence ?? 0,
      lane: answers.lane.choice,
      source: "jev",
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
    message: `source=${route.source} confidence=${route.confidence.toFixed(2)} ownData=${route.asksOwnData.toFixed(2)} human=${route.asksForHuman.toFixed(2)} action=${route.asksForAction.toFixed(2)}`,
    runId: fields.runId,
  });
}
