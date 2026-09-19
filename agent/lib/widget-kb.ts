import { gateway, generateObject } from "ai";
import { z } from "zod";
import { getHelpArticleContent, HELP_CENTER_BASE_URL } from "./help-center.js";
import { fastCallOptions, resolveModel } from "./models.js";
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
const INDEX_TIMEOUT_MS = 5000;
const CHAT_TIMEOUT_MS = 12_000;
const INDEX_CACHE_MS = 10 * 60_000;
const MAX_QUERIES = 3;
const MAX_ARTICLE_CHARS = 8000;
const SEARCH_TIMEOUT_MS = 5000;
// The whole lane measures about 4 to 5s. The cap is generous on purpose: a slow
// answer with sources still beats falling through to a multi-minute investigation.
const KB_TIMEOUT_MS = 25_000;
const MAX_ANSWER_CHARS = 4000;
// One marker, or a group such as [1, 2], which the model also writes.
const MARKER = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/gu;
const MARK_TAG = /<\/?mark>/gu;

const TEXT_ONLY =
  "This chat is text only: the customer cannot attach, paste or upload a file, image, screenshot or recording here, so never ask for one and never describe an upload or attach control. Ask them to describe what they see or paste the exact error text instead.";

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

const indexSchema = z.array(
  z.object({ id: z.string().min(1).max(300), title: z.string().min(1) })
);
type KbIndex = z.infer<typeof indexSchema>;

const selectSchema = z.object({
  articles: z.array(z.number().int()).max(MAX_ARTICLES),
});

const rewriteSchema = z.object({
  queries: z.array(z.string()).min(1).max(MAX_QUERIES),
});

const answerSchema = z.object({
  answer: z.string(),
  // answer: grounded in the articles. chat: a reaction, thanks or small talk
  // that asks nothing. none: a question the articles do not cover.
  kind: z.enum(["answer", "chat", "none"]),
});

const LATEST_SUBJECT = `The message may include earlier turns. Work for the customer's LATEST message: use the earlier turns only to work out what a word like "it", "that" or "the crm one" refers to. When the latest message names or implies its own subject (CRM contacts rather than campaign leads, the subscription rather than domains or inboxes), follow that subject, not the subject of the earlier turns.`;

const KB_PROMPT = `You answer a customer's product question in Acquisity's in-app support chat, using ONLY the numbered help-center articles you are given. Write a short, plain, warm reply in the second person with concrete steps where the articles give them. After each sentence or step that an article supports, add that article's number in square brackets, like [1] or [2]. Use only the numbers you were given. Never state anything the articles do not say, never invent menu names, links or settings, and do not include URLs. Give the steps themselves, as a short numbered list when there are several: never answer by only pointing the customer to an article, a section, or the help center. When the answer is a procedure to set something up, list its steps. When it is troubleshooting, meaning a series of things to check, give only the first one or two checks and ask what they see, so you can guide them from there. The message may include earlier turns: you are continuing that conversation, so never repeat steps or facts Support already gave, and when the customer reports what they saw or did, acknowledge it briefly, accept it, and give only the next step. Plain text only: no markdown, no asterisks, no headings. Cite once per step or paragraph, not after every sentence. A question phrased about "my account" or "my workspace" is still a how-to question: answer it with the general steps from the articles, and never describe or guess the customer's own settings, which you cannot see. You cannot make changes to the customer's account and nobody will make them on their behalf: if they ask you to do something for them, apologise in one short sentence, say you are not able to make changes to their account, and give the steps from the articles so they can do it themselves. Never promise that a teammate, the team or you will do something or follow up. ${LATEST_SUBJECT} A rule or policy in an article applies only to the product that article is about: never apply the policy for one product or charge (for example domains or inboxes) to another (for example the subscription). When the customer's question could be about more than one product or charge and neither their message nor the earlier turns say which, ask which one they mean instead of answering for one of them. ${TEXT_ONLY} Set kind to "answer" when you answer from the articles. Set kind to "chat" when the customer's latest message asks nothing and needs no lookup, such as a reaction, thanks, an acknowledgement, a greeting or small talk: reply in one or two short, friendly sentences like a person would, state no product facts, use no citation numbers, and leave the door open for another question. Set kind to "none" and leave answer empty only when the latest message is a question that none of the articles covers; ignore articles that are irrelevant. No sign-off, no em dashes.`;

// Choosing from the real list of titles beats guessing search keywords: a
// customer asking how to "add" inboxes never matches a guide titled "Buying
// inboxes" lexically, but a model reading both sees they are the same thing.
const SELECT_PROMPT = `You pick help-center articles for a customer's support question. ${LATEST_SUBJECT} You are given the full numbered list of articles as "number. title (path)". Return the numbers of up to ${MAX_ARTICLES} articles most likely to contain the answer, best first. Prefer a specific how-to guide over an index, overview or FAQ listing page. Return an empty list if nothing fits.`;

// The help-center search is lexical and matches short keyword queries against
// article titles. A whole conversational sentence ranks on its filler words
// ("workspace", "new", "add" matching "ad") and misses the right article, so the
// message is turned into keyword queries first.
const REWRITE_PROMPT = `You turn a customer's support message into search queries for a help-center search engine that matches short keywords against article titles. ${LATEST_SUBJECT} Return 1 to ${MAX_QUERIES} queries of 1 to 3 words each, most specific first. Use the product nouns the customer means, and include the likely title wording as well as their wording, for example "buy inboxes" and "email accounts" for someone asking how to add inboxes. No filler words, no punctuation, no questions.`;

// No retrieval and no account data, like CHAT_PROMPT, so nothing to gate.
export const CLARIFY_PROMPT = `You are Foreman, the support assistant in Acquisity's in-app chat. The customer's latest message does not say clearly what they need help with. Ask ONE short, friendly question that gets what you need: which part of the product it is about, and what they expected versus what happened. If they sound frustrated, acknowledge it in a few words first. If the message could mean a few specific things, such as which limit or which charge, offer those as options. State no product facts, guess nothing about their account, and make no promises. Plain text, no sign-off, no em dashes. ${TEXT_ONLY}`;

const chatSchema = z.object({ reply: z.string() });

const CHAT_PROMPT = `You are Foreman, the support assistant in Acquisity's in-app chat. The customer's latest message asks nothing: it is a thank you, a reaction, an acknowledgement, a greeting or small talk. Reply the way a friendly person would, in one or two short sentences, continuing the conversation you are given. State no product facts and make no promises. If it fits, leave the door open for another question. Plain text, no sign-off, no em dashes.`;

/**
 * A short conversational reply to a message that asks nothing. No retrieval, no
 * tools, no account data, so like the rest of this lane there is nothing to
 * gate. Returns null on any failure and the caller carries on as before.
 * Default reasoning on purpose: "minimal" showed 14 to 21s spikes on replies
 * this small, against 1.4 to 3s.
 */
export async function replyToChat(
  message: string,
  log: { conversationId: string; runId: string },
  system: string = CHAT_PROMPT
): Promise<KbAnswer | null> {
  const startedAt = Date.now();
  try {
    const model = await resolveModel("kb");
    const { object } = await generateObject({
      abortSignal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      model: gateway(model),
      prompt: message,
      schema: chatSchema,
      system,
    });
    const reply = object.reply.replace(MARKER, "").trim();
    logOpsEvent("widget.kb.answer", {
      ...log,
      message: `direct ms=${Date.now() - startedAt}`,
      outcome: reply ? "chat" : "miss",
    });
    return reply
      ? { citations: [], message: reply.slice(0, MAX_ANSWER_CHARS) }
      : null;
  } catch (error) {
    logOpsEvent("widget.kb.answer", {
      ...log,
      message: `${error instanceof Error ? error.message.slice(0, 120) : "unknown"} direct ms=${Date.now() - startedAt}`,
      outcome: "error",
    });
    return null;
  }
}

export interface KbDeps {
  generate: (input: {
    articles: KbArticle[];
    question: string;
    signal: AbortSignal;
  }) => Promise<unknown>;
  /** Every article's id and title, or null where the web app has no index route yet. */
  index: (signal: AbortSignal) => Promise<KbIndex | null>;
  read: (url: string, signal: AbortSignal) => Promise<KbArticle | null>;
  rewrite: (question: string, signal: AbortSignal) => Promise<unknown>;
  search: (
    question: string,
    signal: AbortSignal
  ) => Promise<{ title: string; url: string }[]>;
  select: (input: {
    index: KbIndex;
    question: string;
    signal: AbortSignal;
  }) => Promise<unknown>;
}

let indexCache: { at: number; value: KbIndex } | null = null;

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
      ...fastCallOptions(model),
      schema: answerSchema,
      system: KB_PROMPT,
    });
    return object;
  },
  // The list changes only when docs ship, so one warm instance fetches it rarely.
  async index(signal) {
    if (indexCache && Date.now() - indexCache.at < INDEX_CACHE_MS) {
      return indexCache.value;
    }
    const response = await fetch(`${HELP_CENTER_BASE_URL}/api/docs-index`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(INDEX_TIMEOUT_MS)]),
    });
    if (!response.ok) {
      return null;
    }
    const value = indexSchema.parse(await response.json());
    indexCache = { at: Date.now(), value };
    return value;
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
      ...fastCallOptions(model),
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
  async select({ index, question, signal }) {
    const model = await resolveModel("kb");
    const { object } = await generateObject({
      abortSignal: signal,
      model: gateway(model),
      // The listing comes first so the long, stable prefix can be cached.
      prompt: `${index
        .map((article, n) => `${n + 1}. ${article.title} (${article.id})`)
        .join("\n")}\n\nCustomer question: ${question}`,
      ...fastCallOptions(model),
      schema: selectSchema,
      system: SELECT_PROMPT,
    });
    return object;
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

/**
 * The articles to read for a question. Picks from the title index when the web
 * app serves one, and otherwise, or when the pick fails or comes back empty,
 * falls back to keyword search so the lane still works against an older deploy.
 */
async function findArticles(
  question: string,
  signal: AbortSignal,
  deps: KbDeps
): Promise<{ hits: { title: string; url: string }[]; via: string }> {
  try {
    const index = await deps.index(signal);
    if (index) {
      const { articles } = selectSchema.parse(
        await deps.select({ index, question, signal })
      );
      const hits = [...new Set(articles)]
        .map((n) => index[n - 1])
        .filter((article) => article !== undefined)
        .map((article) => ({
          title: article.title,
          url: new URL(`/docs/${article.id}`, HELP_CENTER_BASE_URL).toString(),
        }));
      if (hits.length > 0) {
        return { hits, via: "index" };
      }
    }
  } catch {
    // fall through to keyword search
  }
  const queries = await searchQueries(question, signal, deps);
  return {
    hits: mergeHits(
      await Promise.all(
        queries.map((query) => deps.search(query, signal).catch(() => []))
      )
    ),
    via: "search",
  };
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
 * Turn the model's markers into clean, numbered citations.
 *
 * - Markers may be single ([1]) or grouped ([1, 2]); either way only numbers
 *   that point at a supplied article survive.
 * - Sources are renumbered in order of first use, so the list reads 1, 2, 3.
 * - An answer drawn from one article carries no numbers at all: the Sources list
 *   says everything a marker would.
 * - With several sources, a run of identical markers collapses to its last one,
 *   so a number appears only where the source changes instead of on every line.
 *
 * The model only ever emits numbers; every url comes from the chosen articles.
 */
export function resolveCitations(
  answer: string,
  articles: { title: string; url: string }[]
): KbAnswer {
  const order: number[] = [];
  const pieces: { key: string; text: string }[] = [];
  let last = 0;
  for (const match of answer.matchAll(MARKER)) {
    const cited = [
      ...new Set(
        match[1]
          .split(",")
          .map((digits) => Number(digits.trim()) - 1)
          .filter((index) => articles[index] !== undefined)
      ),
    ];
    for (const index of cited) {
      if (!order.includes(index)) {
        order.push(index);
      }
    }
    const numbers = cited
      .map((index) => order.indexOf(index) + 1)
      .sort((left, right) => left - right);
    pieces.push({
      key: numbers.join(","),
      text: answer.slice(last, match.index),
    });
    last = match.index + match[0].length;
  }
  // With a single source every marker says the same thing as the Sources list,
  // so the numbers are dropped and the list alone carries the attribution.
  const numbered = order.length > 1;
  let message = "";
  pieces.forEach((piece, position) => {
    const endsRun = pieces[position + 1]?.key !== piece.key;
    message += piece.text;
    if (numbered && piece.key && endsRun) {
      message += piece.key
        .split(",")
        .map((n) => `[${n}]`)
        .join("");
    }
  });
  message += answer.slice(last);
  return {
    citations: order.map((index, position) => ({
      n: position + 1,
      title: articles[index].title.slice(0, 300),
      url: articles[index].url,
    })),
    message: message
      .replace(/[ \t]+([.,;:!?])/gu, "$1")
      .replace(/[ \t]{2,}/gu, " ")
      .replace(/[ \t]+$/gmu, "")
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
    const { hits, via } = await findArticles(question, signal, deps);
    mark(`find:${via}`);
    const articles = (
      await Promise.all(hits.map((hit) => deps.read(hit.url, signal)))
    ).filter((article): article is KbArticle => article !== null);
    mark("read");
    const raw = answerSchema.parse(
      await deps.generate({ articles, question, signal })
    );
    mark("generate");
    if (raw.kind === "chat" && raw.answer.trim()) {
      // Conversation, not information: nothing to ground, so nothing to cite.
      finish("chat", marks.join(" "));
      return {
        citations: [],
        message: raw.answer
          .replace(MARKER, "")
          .trim()
          .slice(0, MAX_ANSWER_CHARS),
      };
    }
    const answer =
      raw.kind === "answer" ? resolveCitations(raw.answer, articles) : null;
    // An answer that cites nothing is not grounded in the articles; investigate instead.
    if (!answer?.message || answer.citations.length === 0) {
      finish(
        "miss",
        `articles=${articles.length} kind=${raw.kind} ${marks.join(" ")}`
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
