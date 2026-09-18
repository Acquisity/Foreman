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
const MAX_QUERIES = 3;
const MAX_ARTICLE_CHARS = 8000;
const SEARCH_TIMEOUT_MS = 5000;
// The whole lane measures about 4 to 5s. The cap is generous on purpose: a slow
// answer with sources still beats falling through to a multi-minute investigation.
const KB_TIMEOUT_MS = 25_000;
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

const rewriteSchema = z.object({
  queries: z.array(z.string()).min(1).max(MAX_QUERIES),
});

const answerSchema = z.object({
  answer: z.string(),
  answerable: z.boolean(),
});

// Measured on this lane: left to its default, the model spends about 90% of its
// output on hidden reasoning (roughly 1,900 tokens for a 300-token reply, 8 to
// 12s). These are retrieval-grounded rewrites and summaries, so reasoning is
// turned down: about 3s, with the same grounded, cited answers. Ignored by
// providers that do not recognise it if the `kb` slot is ever overridden.
const FAST_OPTIONS = {
  google: { thinkingConfig: { thinkingLevel: "minimal" } },
} as const;

const KB_PROMPT = `You answer a customer's product question in Acquisity's in-app support chat, using ONLY the numbered help-center articles you are given. Write a short, plain, warm reply in the second person with concrete steps where the articles give them. After each sentence or step that an article supports, add that article's number in square brackets, like [1] or [2]. Use only the numbers you were given. Never state anything the articles do not say, never invent menu names, links or settings, and do not include URLs. Plain text only: no markdown, no asterisks, no headings. A question phrased about "my account" or "my workspace" is still a how-to question: answer it with the general steps from the articles, and never describe or guess the customer's own settings, which you cannot see. Set answerable to false and leave answer empty only when none of the articles covers the topic of the question; ignore articles that are irrelevant. No greetings, no sign-off, no em dashes.`;

// The help-center search is lexical and matches short keyword queries against
// article titles. A whole conversational sentence ranks on its filler words
// ("workspace", "new", "add" matching "ad") and misses the right article, so the
// message is turned into keyword queries first.
const REWRITE_PROMPT = `You turn a customer's support message into search queries for a help-center search engine that matches short keywords against article titles. Return 1 to ${MAX_QUERIES} queries of 1 to 3 words each, most specific first. Use the product nouns the customer means, and include the likely title wording as well as their wording, for example "buy inboxes" and "email accounts" for someone asking how to add inboxes. No filler words, no punctuation, no questions.`;

export interface KbDeps {
  generate: (input: {
    articles: KbArticle[];
    question: string;
    signal: AbortSignal;
  }) => Promise<unknown>;
  read: (url: string, signal: AbortSignal) => Promise<KbArticle | null>;
  rewrite: (question: string, signal: AbortSignal) => Promise<unknown>;
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
      prompt: JSON.stringify({
        articles: articles.map((article, index) => ({
          content: article.content,
          number: index + 1,
          title: article.title,
        })),
        question,
      }),
      providerOptions: {
        ...gatewayRouting(model)?.providerOptions,
        ...FAST_OPTIONS,
      },
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
  async rewrite(question, signal) {
    const model = await resolveModel("kb");
    const { object } = await generateObject({
      abortSignal: signal,
      model: gateway(model),
      prompt: question,
      providerOptions: {
        ...gatewayRouting(model)?.providerOptions,
        ...FAST_OPTIONS,
      },
      schema: rewriteSchema,
      system: REWRITE_PROMPT,
    });
    return object;
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
 * Merge the hits of several queries into one ranked list. Each query votes for
 * an article with the reciprocal of its rank, so an article that several
 * queries agree on, or that one query ranks first, rises to the top.
 */
export function mergeHits(
  results: { title: string; url: string }[][]
): { title: string; url: string }[] {
  const scored = new Map<
    string,
    { hit: { title: string; url: string }; score: number }
  >();
  for (const hits of results) {
    hits.forEach((hit, rank) => {
      const entry = scored.get(hit.url) ?? { hit, score: 0 };
      entry.score += 1 / (rank + 1);
      scored.set(hit.url, entry);
    });
  }
  return [...scored.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_ARTICLES)
    .map((entry) => entry.hit);
}

/** Keyword queries for the message; the raw message is the fallback if the rewrite fails. */
async function searchQueries(
  question: string,
  signal: AbortSignal,
  deps: KbDeps
): Promise<string[]> {
  try {
    const { queries } = rewriteSchema.parse(
      await deps.rewrite(question, signal)
    );
    const cleaned = queries
      .map((query) => query.trim().slice(0, 80))
      .filter((query) => query.length > 0);
    return cleaned.length > 0 ? cleaned : [question];
  } catch {
    return [question];
  }
}

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
  const marks: string[] = [];
  let lap = startedAt;
  const mark = (step: string) => {
    marks.push(`${step}=${Date.now() - lap}`);
    lap = Date.now();
  };
  try {
    const queries = await searchQueries(question, signal, deps);
    mark("rewrite");
    const hits = mergeHits(
      await Promise.all(
        queries.map((query) => deps.search(query, signal).catch(() => []))
      )
    );
    mark("search");
    const articles = (
      await Promise.all(hits.map((hit) => deps.read(hit.url, signal)))
    ).filter((article): article is KbArticle => article !== null);
    mark("read");
    if (articles.length === 0) {
      finish("miss", `hits=${hits.length} articles=0 ${marks.join(" ")}`);
      return null;
    }
    const raw = answerSchema.parse(
      await deps.generate({ articles, question, signal })
    );
    mark("generate");
    const answer = raw.answerable
      ? resolveCitations(raw.answer, articles)
      : null;
    // An answer that cites nothing is not grounded in the articles; investigate instead.
    if (!answer?.message || answer.citations.length === 0) {
      finish(
        "miss",
        `articles=${articles.length} answerable=${raw.answerable} ${marks.join(" ")}`
      );
      return null;
    }
    finish(
      "ok",
      `articles=${articles.length} citations=${answer.citations.length} ${marks.join(" ")}`
    );
    return answer;
  } catch (error) {
    mark("failed");
    finish(
      "error",
      `${error instanceof Error ? error.message.slice(0, 100) : "unknown"} ${marks.join(" ")}`
    );
    return null;
  }
}
