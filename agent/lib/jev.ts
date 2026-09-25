import { getVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";

/**
 * Jev, TypeSafe's decision model, reached through the Vercel AI Gateway so the
 * company account pays for it.
 *
 * @remarks
 * Jev answers typed questions about one shared state: a `boolean` returns a
 * probability, a `choice` picks one named option, a `score` rates an ordered
 * scale. Every question in one request is answered in parallel against the
 * same state and the state is billed once, so a caller batches every question
 * a decision might need into one call and branches in code afterwards.
 *
 * Requests are restricted to TypeSafe itself: the gateway would otherwise fall
 * back to another host on an outage, and the state carries ticket text.
 * Authentication is the gateway key when one is set, else the deployment's
 * Vercel OIDC token, the same order the gateway provider uses.
 */
export const JEV_MODEL = "typesafe-ai/jev";
const JEV_URL = "https://ai-gateway.vercel.sh/v1/evaluate";
const JEV_TIMEOUT_MS = 15_000;

export type JevQuestion =
  | { type: "boolean"; instructions: string }
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string>;
    }
  | { type: "score"; instructions: string; criteria: string[] };

const answerSchema = z.discriminatedUnion("type", [
  z.object({
    probability: z.number().min(0).max(1),
    type: z.literal("boolean"),
  }),
  z.object({
    choice: z.string(),
    probabilities: z.record(z.string(), z.number().min(0).max(1)),
    type: z.literal("choice"),
  }),
  z.object({
    probabilities: z.record(z.string(), z.number().min(0).max(1)),
    score: z.number(),
    type: z.literal("score"),
  }),
]);
export type JevAnswer = z.infer<typeof answerSchema>;

const responseSchema = z.object({
  answers: z.record(z.string(), answerSchema),
  model: z.string(),
});

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface JevOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
  token?: string;
}

const resolveToken = async (): Promise<string> =>
  process.env.AI_GATEWAY_API_KEY || (await getVercelOidcToken());

/** Rejects when `signal` aborts first, so a stalled step still ends in time. */
const beforeAbort = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
    work.then(resolve, reject);
  });

/**
 * Asks Jev every question in one request. Throws on a missing credential, a
 * timeout, a bad status, or an answer missing or off its menu, so a caller
 * never branches on a guess.
 */
export async function askJev(
  questions: Record<string, JevQuestion>,
  state: unknown,
  opts: JevOptions = {}
): Promise<Record<string, JevAnswer>> {
  const timeout = AbortSignal.timeout(JEV_TIMEOUT_MS);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeout])
    : timeout;
  const token = opts.token ?? (await beforeAbort(resolveToken(), signal));
  const response = await (opts.fetch ?? fetch)(JEV_URL, {
    body: JSON.stringify({
      model: JEV_MODEL,
      providerOptions: { gateway: { only: ["typesafe-ai"] } },
      questions,
      state,
    }),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Jev request failed with HTTP ${response.status}.`);
  }
  const { answers } = responseSchema.parse(await response.json());
  for (const [key, question] of Object.entries(questions)) {
    const answer = answers[key];
    if (answer?.type !== question.type) {
      throw new Error(`Jev returned no ${question.type} answer for ${key}.`);
    }
    if (
      answer.type === "choice" &&
      question.type === "choice" &&
      !Object.hasOwn(question.criteria, answer.choice)
    ) {
      throw new Error(`Jev chose ${answer.choice}, not an option for ${key}.`);
    }
  }
  return answers;
}

/** The winning option of a choice and how much of the probability it holds. */
export const choiceOf = (
  answer: JevAnswer | undefined
): { choice: string; confidence: number } => {
  if (answer?.type !== "choice") {
    throw new Error("Expected a choice answer.");
  }
  return {
    choice: answer.choice,
    confidence: answer.probabilities[answer.choice] ?? 0,
  };
};

export const probabilityOf = (answer: JevAnswer | undefined): number => {
  if (answer?.type !== "boolean") {
    throw new Error("Expected a boolean answer.");
  }
  return answer.probability;
};
