import { gateway, generateObject } from "ai";
import { z } from "zod";
import { getHelpArticleContent, HELP_CENTER_BASE_URL } from "./help-center.js";
import { gatewayRouting, resolveModel } from "./models.js";
import { logOpsEvent } from "./ops-log.js";

/**
 * The fast lane for general product questions: search the public help center,
 * read the top articles, and answer from them in one model call.
 *
 * @remarks
 * This lane is ungated on purpose. It has no tools and never receives account
 * data: its only inputs are the customer's own message and public help-center
 * articles, so there is nothing cross-tenant for the egress gate to guard. Keep
 * it that way. Giving this lane any account lookup brings the gate back.
 *
 * It returns null whenever it cannot answer from the articles, and the caller
 * falls through to the investigation lane, so a miss costs latency, never a
 * wrong or empty reply.
 */

const MAX_ARTICLES = 4;
const MAX_ARTICLE_CHARS = 8000;
const SEARCH_TIMEOUT_MS = 5000;
const KB_TIMEOUT_MS = 15_000;
const MAX_ANSWER_CHARS = 4000;
const MARKER = /\[(\d{1,2})\]/gu;
const MARK_TAG = /<\/?mark>/gu;

export const kbCitationSchema = z.object({
  n: z.number().int().positive(),
  title: z.string().min(1).max(300),
  url: z.string().url().max(500),
});
export type KbCitation = z.infer<typeof kbCitationSchema>;

export interface KbAnswer {
  citations: KbCitation[];
  message: string;
}

interface KbArticle {
  content: string;
  title: string;
  url: string;
}

const hitSchema = z.looseObject({
  content: z.string(),
  type: z.string().optional(),
  url: z.string(),
});

const answerSchema = z.object({
  answer: z.string(),
  answerable: z.boolean(),
});

const KB_PROMPT = `You answer a customer's product question in Acquisity's in-app support chat, using ONLY the numbered help-center articles you are given. Write a short, plain, warm reply in the second person with concrete steps where the articles give them. After each sentence or step that an article supports, add that article's number in square brackets, like [1] or [2]. Use only the numbers you were given. Never state anything the articles do not say, never invent menu names, links or settings, and do not include URLs. You cannot see the customer's account, so never claim to know how their workspace is configured. If the articles do not answer the question, set answerable to false and leave answer empty. No greetings, no sign-off, no em dashes.`;

export interface KbDeps {
  generate: (input: {
    articles: KbArticle[];
    question: string;
    signal: AbortSignal;
  }) => Promise<unknown>;
  read: (url: string, signal: AbortSignal) => Promise<KbArticle | null>;
  search: (
    question: string,
    signal: AbortSignal
  ) => Promise<{ title: string; url: string }[]>;
}

export const defaultKbDeps: KbDeps = {
  async generate({ articles, question, signal }) {
    const model = await resolveModel("kb");
    const { object } = await generateObject({
      abortSignal: signal,
      model: gateway(model),
      ...gatewayRouting(model),
      prompt: JSON.stringify({
        articles: articles.map((article, index) => ({
          content: article.content,
          number: index + 1,
          title: article.title,
        })),
        question,
      }),
      schema: answerSchema,
      system: KB_PROMPT,
    });
    return object;
  },
  async read(url, signal) {
    const article = await getHelpArticleContent(url, { signal });
    if ("error" in article || !article.content.trim()) {
      return null;
    }
    return {
      content: article.content.slice(0, MAX_ARTICLE_CHARS),
      title: article.title ?? url,
      url,
    };
  },
  // The help-center search is a public route, so this lane calls it directly
  // rather than through the per-tenant executor the investigator's tool uses.
  async search(question, signal) {
    const response = await fetch(
      `${HELP_CENTER_BASE_URL}/api/search?query=${encodeURIComponent(question)}`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        ]),
      }
    );
    if (!response.ok) {
      return [];
    }
    return z
      .array(hitSchema)
      .parse(await response.json())
      .filter((hit) => hit.type === undefined || hit.type === "page")
      .slice(0, MAX_ARTICLES)
      .map((hit) => ({
        title: hit.content.replace(MARK_TAG, ""),
        url: new URL(hit.url, HELP_CENTER_BASE_URL).toString(),
      }));
  },
};

/**
 * Keep only markers that point at a supplied article, and renumber them in
 * order of first use so the Source list reads 1, 2, 3 with no gaps. The model
 * only ever emits numbers; every url comes from the search hits.
 */
export function resolveCitations(
  answer: string,
  articles: { title: string; url: string }[]
): KbAnswer {
  const order: number[] = [];
  const message = answer.replace(MARKER, (_match, digits: string) => {
    const index = Number(digits) - 1;
    if (!articles[index]) {
      return "";
    }
    if (!order.includes(index)) {
      order.push(index);
    }
    return `[${order.indexOf(index) + 1}]`;
  });
  return {
    citations: order.map((index, position) => ({
      n: position + 1,
      title: articles[index].title.slice(0, 300),
      url: articles[index].url,
    })),
    message: message
      .replace(/[ \t]+([.,;:!?])/gu, "$1")
      .replace(/[ \t]{2,}/gu, " ")
      .trim()
      .slice(0, MAX_ANSWER_CHARS),
  };
}

export async function answerFromHelpCenter(
  question: string,
  log: { conversationId: string; runId: string },
  deps: KbDeps = defaultKbDeps
): Promise<KbAnswer | null> {
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(KB_TIMEOUT_MS);
  const finish = (outcome: string, detail: string) =>
    logOpsEvent("widget.kb.answer", {
      ...log,
      message: `${detail} ms=${Date.now() - startedAt}`,
      outcome,
    });
  try {
    const hits = await deps.search(question, signal);
    const articles = (
      await Promise.all(hits.map((hit) => deps.read(hit.url, signal)))
    ).filter((article): article is KbArticle => article !== null);
    if (articles.length === 0) {
      finish("miss", `hits=${hits.length} articles=0`);
      return null;
    }
    const raw = answerSchema.parse(
      await deps.generate({ articles, question, signal })
    );
    const answer = raw.answerable
      ? resolveCitations(raw.answer, articles)
      : null;
    // An answer that cites nothing is not grounded in the articles; investigate instead.
    if (!answer?.message || answer.citations.length === 0) {
      finish(
        "miss",
        `articles=${articles.length} answerable=${raw.answerable}`
      );
      return null;
    }
    finish(
      "ok",
      `articles=${articles.length} citations=${answer.citations.length}`
    );
    return answer;
  } catch (error) {
    finish(
      "error",
      error instanceof Error ? error.message.slice(0, 150) : "unknown"
    );
    return null;
  }
}
