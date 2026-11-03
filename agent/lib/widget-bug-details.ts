import { randomUUID } from "node:crypto";
import { z } from "zod";
import { logOpsEvent } from "./ops-log.js";
import { askJev, jevKey, type SelectorOptions } from "./widget-next-action.js";
import { DECISION_CONTEXT, renderConversation } from "./widget-router.js";

/**
 * The "I found a bug" path in Acquisity's support chat (ENG-17031). Acquisity
 * walks the steps and files the ticket itself; Foreman only judges whether the
 * customer's report is missing something an engineer needs and, if so, which
 * fixed question to ask. Jev scores the report, so no generated text reaches
 * the customer and nothing here investigates or files. Any failure throws, and
 * Acquisity then skips straight to its recording step.
 */

const BUG_DETAILS_JEV_MS = [3000, 3000];
const PRESENT_SCORE = 0.5;

const DETAILS = {
  says_goal: {
    instructions:
      "Across the whole conversation, the customer says what they were trying to do when the problem happened, for example sending a campaign, importing contacts, connecting an inbox or publishing a website.",
    type: "noul",
  },
  says_problem: {
    instructions:
      "Across the whole conversation, the customer says what went wrong in a way an engineer could look for: what they saw, an error message, what did not happen, or what happened instead. A bare complaint such as 'it isn't working', 'it's broken' or 'I found a bug' is NOT this.",
    type: "noul",
  },
  says_where: {
    instructions:
      "Across the whole conversation, the customer names where in the product it happened: a page, a screen, a feature or tool by name, or a specific campaign, website, workflow or contact.",
    type: "noul",
  },
} as const;

/** The first detail the report is missing, in this order, gets its question. */
const ASK_ORDER = ["says_problem", "says_goal", "says_where"] as const;

export const BUG_DETAIL_QUESTIONS = {
  says_goal: "What were you trying to do when this happened?",
  says_problem:
    "What happened when it went wrong? An error message, or what you saw on the screen, helps a lot.",
  says_where:
    "Where in Acquisity did this happen? The page name, or the campaign or website you were working on, is perfect.",
} as const satisfies Record<keyof typeof DETAILS, string>;

const score = z.object({ noul: z.number().min(0).max(1) });
const answersSchema = z.object({
  answers: z.object({
    says_goal: score,
    says_problem: score,
    says_where: score,
  }),
});

export interface BugDetailsResponse {
  bug_details: "ask" | "pass";
  decision: "allow";
  message: string | null;
  run_id: string;
  status: "completed";
}

export async function bugDetailsTurn(
  input: { asked: string[]; conversation: string; conversationId: string },
  opts: SelectorOptions & { signal?: AbortSignal } = {}
): Promise<BugDetailsResponse> {
  const apiKey = opts.apiKey ?? jevKey();
  if (!apiKey) {
    throw new Error("no_key");
  }
  const { answers } = answersSchema.parse(
    await askJev(DETAILS, input.conversation, apiKey, {
      ...opts,
      timeoutMs: BUG_DETAILS_JEV_MS,
    })
  );
  // A question already asked is never repeated: a second thin answer moves on
  // to the next missing detail, or passes.
  const missing = ASK_ORDER.find(
    (detail) =>
      answers[detail].noul < PRESENT_SCORE &&
      !input.asked.includes(BUG_DETAIL_QUESTIONS[detail])
  );
  logOpsEvent("widget.bug_details.decided", {
    conversationId: input.conversationId,
    decision: missing ?? "pass",
  });
  return {
    bug_details: missing ? "ask" : "pass",
    decision: "allow",
    message: missing ? BUG_DETAIL_QUESTIONS[missing] : null,
    run_id: randomUUID(),
    status: "completed",
  };
}

const failureReason = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  if (message === "no_key" || message.startsWith("http_")) {
    return message;
  }
  if (error instanceof z.ZodError) {
    return "malformed";
  }
  return error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
    ? "timeout"
    : "error";
};

/** The widget route's bug_details turn. A failure is logged here and rethrown, so the route answers 503. */
export async function answerBugDetails(
  input: {
    conversationId: string;
    history?: { role: "assistant" | "customer"; text: string }[];
    question: string;
    screenshots?: string[];
  },
  signal: AbortSignal,
  turn: typeof bugDetailsTurn = bugDetailsTurn
): Promise<BugDetailsResponse> {
  try {
    return await turn(
      {
        asked: (input.history ?? [])
          .filter((entry) => entry.role === "assistant")
          .map((entry) => entry.text.trim()),
        conversation: renderConversation(
          input.question,
          input.history,
          DECISION_CONTEXT,
          input.screenshots
        ),
        conversationId: input.conversationId,
      },
      { signal }
    );
  } catch (error) {
    logOpsEvent(
      "widget.bug_details.failed",
      {
        conversationId: input.conversationId,
        message: failureReason(error),
      },
      console.warn
    );
    throw error;
  }
}
