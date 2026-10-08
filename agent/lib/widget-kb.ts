import { setTimeout as sleep } from "node:timers/promises";
import { gateway, generateObject } from "ai";
import { z } from "zod";
import { sniffImage } from "../subagents/vision/tools/read_image.js";
import {
  getHelpArticleContent,
  HELP_CENTER_BASE_URL,
  helpArticleSlug,
} from "./help-center.js";
import { fastCallOptions, resolveModel } from "./models.js";
import { logOpsEvent } from "./ops-log.js";
import {
  DECISION_CONTEXT,
  RECORDING_RULE,
  recentTurns,
  toAsk,
  type WidgetAsk,
} from "./widget-router.js";

/**
 * The front door's one writer: search the public help center, read the top
 * articles, and have one model reply to the conversation from them.
 *
 * @remarks
 * This lane is ungated on purpose. It has no tools and never receives account
 * data: its only inputs are the customer's own message and public help-center
 * articles, so there is nothing cross-tenant for the egress gate to guard. Keep
 * it that way. Giving this lane any account lookup brings the gate back.
 *
 * Product facts come only from the articles; a reply that cites nothing, such
 * as a thank-you or a plain "I'm not sure", is still delivered.
 */

const MAX_ARTICLES = 4;
/** How many previously cited articles ride along with every fresh retrieval. */
const MAX_ACTIVE_ARTICLES = 2;
const INDEX_TIMEOUT_MS = 5000;
const INDEX_CACHE_MS = 10 * 60_000;
const MAX_QUERIES = 3;
const MAX_ARTICLE_CHARS = 8000;
const SEARCH_TIMEOUT_MS = 5000;
// Article selection and answer generation are sequential model calls. Live
// selection alone can take 15s; leave time for the grounded answer as well.
const KB_TIMEOUT_MS = 45_000;
/**
 * gemini-3.5-flash through the gateway is bimodal, about 2s or a 15 to 20s
 * stall (widget-screenshot.ts), and a failed call used to wait 2 then 4s for
 * the SDK's unlogged retries: the help-center lane took 15 to 45s and chat
 * replies timed out on "Delay was aborted" (2026-09-28). So a call still
 * running after this is raced by a second identical one.
 */
export const HEDGE_AFTER_MS = 4000;

/**
 * The check after the writer (ENG-14932) has its own deadline inside the
 * lane's: a slow check sends the writer's reply rather than eating the turn.
 */
const GROUND_TIMEOUT_MS = 8000;

const MAX_ANSWER_CHARS = 4000;
const MAX_DESCRIPTION_CHARS = 160;
const MAX_KEYWORDS = 8;
// One marker, or a group such as [1, 2], which the model also writes.
const MARKER = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/gu;
const MARK_TAG = /<\/?mark>/gu;

const TEXT_ONLY = `The customer can attach up to three screenshots to a message. A screenshot reaches you as a labelled reading made by an image model, not as the image: treat what it says as what the customer's screen showed, and when it names something it could not read, do not guess at it. When the exact error text or the screen they are on would settle the question, you may ask them to paste a screenshot or the exact error text. ${RECORDING_RULE} Answer what the customer is trying to do. A screenshot reading shows where they are: use it to place them in the steps. When it shows a warning or error they did not ask about, answer first and then mention it in one short sentence; when they ask about it, answer that. Never describe anything the reading does not say.`;

/**
 * TEXT_ONLY for a writer or selector that has the screenshots themselves. A
 * reading is made before the customer sends, without the conversation, so it
 * leads with warnings and leaves out the button they need next; with the image
 * the model sees where they are, as a support person would.
 */
const WITH_IMAGES = `The customer can attach up to three screenshots to a message. The screenshots attached to their latest message are the images with this input: they show the customer's screen as they wrote it. Look at them the way a support person would: see where the customer is and what they can click there, and use that to give the next step toward what they are trying to do in this conversation. When the screen shows a warning or error they did not ask about, answer first and then mention it in one short sentence; when they ask about it, answer that. Never describe anything you cannot see clearly. ${RECORDING_RULE}`;

interface KbImage {
  data: Uint8Array;
  mediaType: string;
}

const withImages = (system: string, images: KbImage[] | undefined) =>
  images?.length ? system.replace(TEXT_ONLY, WITH_IMAGES) : system;

/** The input as one user message: the text, then each screenshot. */
const withImageParts = (text: string, images: KbImage[] | undefined) => [
  {
    content: [
      { text, type: "text" as const },
      ...(images ?? []).map((image) => ({
        data: image.data,
        mediaType: image.mediaType,
        type: "file" as const,
      })),
    ],
    role: "user" as const,
  },
];

const IMAGE_TIMEOUT_MS = 5000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** The screenshots behind the links. One that fails to load is left out; its reading still stands. */
export async function loadImages(
  urls: string[],
  signal: AbortSignal
): Promise<KbImage[]> {
  const loaded = await Promise.all(
    urls.map(async (url): Promise<KbImage | null> => {
      try {
        const response = await fetch(url, {
          redirect: "error",
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(IMAGE_TIMEOUT_MS),
          ]),
        });
        if (
          !response.ok ||
          Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES
        ) {
          return null;
        }
        const data = Buffer.from(await response.arrayBuffer());
        const mediaType = sniffImage(data);
        return mediaType && data.length <= MAX_IMAGE_BYTES
          ? { data, mediaType }
          : null;
      } catch {
        return null;
      }
    })
  );
  return loaded.filter((image): image is KbImage => image !== null);
}

/**
 * Every stage of this lane reads the conversation as a chat transcript, oldest
 * first and the latest message last, with a screenshot labelled the way the app
 * labels it in history. Latest-first with the rest marked "context only", a
 * screenshot's warning outranked the customer's own request two turns earlier.
 * The decision budget, not the one-line reply budget: four turns lost the
 * customer's own request two detours later ("where can i add new inboxes").
 */
export const renderTranscript = (ask: WidgetAsk): string =>
  [
    ...recentTurns(ask.turns, DECISION_CONTEXT),
    `Customer: ${[ask.latest, ...(ask.screenshots ?? []).map((reading) => `Screenshot reading: ${reading}`)].join("\n\n")}`,
  ].join("\n");

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

// description and keywords are optional so an older web deploy still parses.
const indexSchema = z.array(
  z.object({
    description: z.string().optional(),
    id: z.string().min(1).max(300),
    keywords: z.array(z.string()).optional(),
    title: z.string().min(1),
  })
);
type KbIndex = z.infer<typeof indexSchema>;

// Fin's rerank stage (ENG-14932): each pick says whether it answers the
// question itself or only sits next to it, and only direct picks are read.
// Related ones are what the writer blended into wrong menu paths.
const selectSchema = z.object({
  articles: z
    .array(
      z.object({
        fit: z.enum(["direct", "related"]),
        n: z.number().int(),
      })
    )
    .max(MAX_ARTICLES),
});

const rewriteSchema = z.object({
  queries: z.array(z.string()).min(1).max(MAX_QUERIES),
});

const replySchema = z.object({
  reply: z.string(),
  // The article numbers the reply uses, apart from its text: flash-lite wrote
  // correct answers with no markers in about 1 in 30 runs (2026-09-28).
  sources: z.array(z.number().int()),
});

const LATEST_SUBJECT = `The input is the support conversation so far, oldest first, ending with the customer's latest message. Work out what the customer is trying to do from the whole conversation, the way a support person reading the chat would. A screenshot reading shows where the customer is on the way there: a warning or error on it is not what they are asking about unless their message asks about it. When the latest message itself asks about something new (CRM contacts rather than campaign leads, the subscription rather than domains or inboxes), follow that new subject.`;

/** Who Foreman is, before any rule about what it may say. */
const FOREMAN_VOICE = `You are Foreman, Acquisity's support teammate in the in-app chat. You know how the product works, campaigns, the AI SDR, inboxes and domains, websites, the CRM, billing and the rest, and you help customers understand and use it. You are not a sales, strategy or copywriting coach. Talk like a knowledgeable colleague: warm, direct, in the second person, in short paragraphs. Answer first, with no preamble and no sign-off. Use a numbered list only for a real procedure. You are continuing the conversation you are given: never ask for something it already gave, never repeat your previous reply, and when the customer reports what they saw or did, accept it and give the next step. When they sound frustrated, acknowledge it in a few words and try a different approach.`;

// The one front-door writer (ENG-14932). No account data and no tools reach it.
export const REPLY_PROMPT = `${FOREMAN_VOICE}

The input is JSON: conversation, customer (their workspace name, their role, and canInvestigate), recordingOffered, and articles, the numbered help-center articles found for this conversation. ${LATEST_SUBJECT}

Facts specific to Acquisity come only from the articles: where something is, what a setting does, steps, limits, plans, prices, and whether a feature exists. After a sentence or step that uses an article, add its number in square brackets, like [1], once per step or paragraph, and only numbers you were given. Never invent menu names, links, settings or URLs. When more than one article touches a point, cite the one whose own topic is the latest message. A rule in an article applies only to the product that article is about, so never carry the policy for one product or charge (such as domains or inboxes) over to another (such as the subscription). When the question could be about more than one product or charge and the conversation does not say which, ask which one.

When a screenshot arrives with no question and no earlier customer goal, ask one short question about what they want to do and never infer a task from the page or a warning; when it continues an earlier stated goal, give the next step toward that goal.

Explaining what a product term or feature means and how the pieces fit together is your job, from the articles. Give the steps themselves, never only a pointer to an article or the help center. For a procedure, give every step the articles give, in order, starting with how to reach the page, and keep every warning or lasting consequence they attach, such as data deleted for good or inboxes that must warm up before sending. When the next step depends on the customer's situation, give each case the articles describe. For troubleshooting, give the first one or two checks and ask what they see. A timezone conversion is only a possible explanation, never proof of how their calendar is set up.

Refer to the AI Consultant, using its help article, only when the customer asks you to give advice or strategy, write or review their copy, or assess their campaign performance; otherwise do not mention it.

When the articles do not give a product fact you need, say plainly that you are not sure, then ask the one question that would help find it, or give the next step. When canInvestigate is true, that next step is the magnifying glass next to the message box: they can tap it and send their message again to start a look into their workspace. When it is false, they can ask a workspace owner or admin, and you never mention the magnifying glass.

You cannot see the customer's account, workspace, campaigns or billing: never say or suggest that you looked. You cannot make changes and nobody will make them for them, so give the steps for them to do it themselves. Never promise that Foreman, a person, a teammate, the team or a queue will look into, see, pick up, act on or follow up on this message: nobody is notified. A thanks, greeting or reaction gets a short friendly reply with no product facts.

Plain text only: no markdown, no headings, no asterisks, no em dashes. A numbered list puts each step on its own line, starting with its number and a full stop, such as "1. ".

${TEXT_ONLY}

Return the reply, and in sources the number of every article it uses, empty when it uses none.`;

// The check after the writer, modelled on Intercom Fin's validate stage
// (ENG-14932). The writer blended near-miss articles, stretched them and
// stated uncited assumptions in about 14 of 108 replies; stronger writers
// invented more, so a second read against the same articles trims instead.
export const GROUND_PROMPT = `You check a support reply before it is sent. The input is JSON: conversation, the support conversation so far ending with the customer's latest message; reply, the reply a support writer drafted for it; articles, the numbered help-center articles the writer was given; promptFacts, facts the writer was given apart from the articles; and nextStep, what the customer can do when an answer is not known.

Go through the reply sentence by sentence and find every claim about Acquisity itself: where something is in the product, what a setting or feature does or cannot do, steps, limits, plans, prices, whether something exists, works or happens automatically, and anything about the customer's account or setup. For each claim, find the article sentence or promptFacts entry that says it. A claim is unsupported when none does. In particular:
- A yes or no answer, or a word like always, never, cannot, only, automatically or not supported, is unsupported unless an article says that itself. An article that describes how something works does not say whether it can be changed or turned off.
- A tool, app, integration or example that no article names is not covered by an article about other ones: a yes or no about it, or a step that uses it in a setting, is unsupported.
- A claim placed on a different page or setting from the one the article names, or carried over from an article about a different feature, is unsupported.
- What the customer said, what their screenshot showed, and what the reply's writer ("I") can or cannot do for them are not product claims.

Two examples. An article says "Paste your Zoom or Riverside room link into Meeting Link." A reply saying "Yes, you can paste your Teams link there" is unsupported, because no article names Teams: write "I'm not sure a Teams link works there" and keep the steps for the links the article names. An article says "New inboxes warm up for 14 days before sending." A reply saying "You can't skip warmup" is unsupported, because the article does not say whether it can be skipped: write "I'm not sure whether warmup can be skipped" and keep the 14 days.

In unsupported, list each unsupported claim as it is written in the reply, or nothing. Then return in reply the reply with each unsupported claim removed, or replaced by a short sentence saying you are not sure about that specific thing, and edit only as much of the surrounding sentence as it needs to still read naturally. Keep every supported sentence and step. When nothing the customer can do is left, no step, question or referral, add nextStep in one short sentence. Change nothing else: keep the tone, wording, questions, numbered steps, line breaks, referrals and bracketed article numbers such as [1] exactly as they are, and never add a bracketed number. When unsupported is empty, return the reply exactly as given.

Then set stillAnswers: false only when your reply, after trimming, gives the customer nothing useful toward their latest message, or reads as broken or no longer makes sense. A reply that says you are not sure about one point and keeps supported facts or steps about what they asked still answers, so it is true; so is a short reply to a thanks or greeting. When stillAnswers is false, write notSure: a short honest reply to the latest message that says plainly you are not sure about that part, then gives one next step, either one question that would find the right guide or nextStep. Otherwise leave notSure empty.

Plain text only, no markdown and no em dashes.`;

/** REPLY_PROMPT's own next step for an answer the articles do not give. */
const nextStep = (customer: KbCustomer | undefined) =>
  customer?.canInvestigate
    ? "Tap the magnifying glass next to the message box and send the message again to start a look into the workspace."
    : "Ask a workspace owner or admin.";

/** What REPLY_PROMPT itself tells the writer, so the check never trims it. */
const promptFacts = (customer: KbCustomer | undefined) => [
  ...(customer?.canInvestigate ? [nextStep(customer)] : []),
  "Foreman, the writer, does not write or review copy, give strategy, or assess campaign performance, and says so.",
  "The AI Consultant is under the Chat toggle at the top of the left sidebar, for advice, strategy, copywriting and campaign performance reviews.",
  "Foreman cannot see the customer's account and cannot make changes; nobody makes changes on the customer's behalf, so the customer does the steps themselves.",
];

// biome-ignore assist/source/useSortedKeys: claims first, so the model checks before it rewrites.
const groundSchema = z.object({
  unsupported: z.array(z.string()),
  reply: z.string(),
  stillAnswers: z.boolean(),
  notSure: z.string(),
});

// Choosing from the real list of titles beats guessing search keywords: a
// customer asking how to "add" inboxes never matches a guide titled "Buying
// inboxes" lexically, but a model reading both sees they are the same thing.
export const SELECT_PROMPT = `You pick help-center articles for a customer's support question. ${LATEST_SUBJECT} You are given the full numbered list of articles as "number. title (path): description [keywords]". Many articles share a title such as Overview or Frequently Asked Questions: tell them apart by path and description. Return up to ${MAX_ARTICLES} articles most likely to contain the answer, best first, each with its number and its fit: direct when the article itself is about what the customer asks (the same feature, page, setting or task), related when it is about a neighbouring feature, page or setting that does not answer the question itself. When the conversation lists articles the previous reply cited, pick them again only when they are still direct for the latest message. Prefer a specific how-to guide over an index, overview or FAQ listing page. Choose AI Consultant articles only when the customer asks you to give advice or strategy, write or review their copy, or assess their campaign performance; otherwise do not select them. Return an empty list if nothing fits.`;

// The help-center search is lexical and matches short keyword queries against
// article titles. A whole conversational sentence ranks on its filler words
// ("workspace", "new", "add" matching "ad") and misses the right article, so the
// message is turned into keyword queries first.
const REWRITE_PROMPT = `You turn a customer's support message into search queries for a help-center search engine that matches short keywords against article titles. ${LATEST_SUBJECT} Return 1 to ${MAX_QUERIES} queries of 1 to 3 words each, most specific first. Use the product nouns the customer means, and include the likely title wording as well as their wording, for example "buy inboxes" and "email accounts" for someone asking how to add inboxes. No filler words, no punctuation, no questions.`;

/** The failure as a fixed code: the error class and any HTTP status, never a body. */
const modelFailure = (error: unknown) => {
  if (!(error instanceof Error)) {
    return "unknown";
  }
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? `${error.name}:${status}` : error.name;
};

/**
 * One help-center model call, hedged like the screenshot read: a call still
 * running after {@link HEDGE_AFTER_MS}, or one that fails, starts a second
 * identical call, and the first to finish wins. Every failed try is logged
 * with its reason, which the SDK's in-place retries used to hide.
 */
export async function hedged<T>(
  step: string,
  signal: AbortSignal,
  call: (signal: AbortSignal) => Promise<T>,
  hedgeAfterMs = HEDGE_AFTER_MS
): Promise<T> {
  const settled = new AbortController();
  const scoped = AbortSignal.any([signal, settled.signal]);
  const startedAt = Date.now();
  const attempt = (n: number) =>
    call(scoped).catch((error: unknown) => {
      if (!settled.signal.aborted) {
        logOpsEvent("widget.kb.model", {
          message: `step=${step} attempt=${n} reason=${modelFailure(error)} ms=${Date.now() - startedAt}`,
          outcome: "error",
        });
      }
      throw error;
    });
  const primary = attempt(1);
  const backup = (async () => {
    await Promise.race([
      sleep(hedgeAfterMs, undefined, { signal: scoped }),
      // A failed primary starts the backup at once; a successful one never
      // does, since the abort below ends the wait first.
      primary.then(
        () => new Promise<never>(() => undefined),
        () => undefined
      ),
    ]);
    return attempt(2);
  })();
  try {
    return await Promise.any([primary, backup]);
  } catch (error) {
    // Both failed: surface the last reason, not "All promises were rejected".
    throw error instanceof AggregateError ? error.errors.at(-1) : error;
  } finally {
    settled.abort();
  }
}

/** Who is writing in, from the verified widget scope: never from the message. */
export interface KbCustomer {
  /** An owner or admin outside help-center mode, who can start a look with the magnifying glass. */
  canInvestigate: boolean;
  role: string;
  workspace: string;
}

export interface KbDeps {
  generate: (input: {
    articles: KbArticle[];
    customer?: KbCustomer;
    images?: KbImage[];
    question: string;
    /** See {@link WidgetAsk.recordingOffered}; absent, the writer is told false. */
    recordingOffered?: boolean;
    signal: AbortSignal;
  }) => Promise<unknown>;
  /** The writer's reply checked against the articles it was given; see GROUND_PROMPT. */
  ground: (input: {
    articles: KbArticle[];
    customer?: KbCustomer;
    question: string;
    reply: string;
    signal: AbortSignal;
  }) => Promise<unknown>;
  /** The screenshots behind `WidgetAsk.images`; absent, the lane reads only their readings. */
  images?: (urls: string[], signal: AbortSignal) => Promise<KbImage[]>;
  /** Every article's id and title, or null where the web app has no index route yet. */
  index: (signal: AbortSignal) => Promise<KbIndex | null>;
  read: (url: string, signal: AbortSignal) => Promise<KbArticle | null>;
  rewrite: (question: string, signal: AbortSignal) => Promise<unknown>;
  search: (
    question: string,
    signal: AbortSignal
  ) => Promise<{ title: string; url: string }[]>;
  select: (input: {
    images?: KbImage[];
    index: KbIndex;
    question: string;
    signal: AbortSignal;
  }) => Promise<unknown>;
}

let indexCache: { at: number; value: KbIndex } | null = null;

const articleInput = (articles: KbArticle[]) =>
  articles.map((article, index) => ({
    content: article.content,
    number: index + 1,
    title: article.title,
  }));

export const defaultKbDeps: KbDeps = {
  async generate({
    articles,
    customer,
    images,
    question,
    recordingOffered,
    signal,
  }) {
    const model = await resolveModel(images?.length ? "kbImages" : "kb");
    const input = JSON.stringify({
      articles: articleInput(articles),
      conversation: question,
      customer: customer ?? {
        canInvestigate: false,
        role: "unknown",
        workspace: "unknown",
      },
      recordingOffered: recordingOffered === true,
    });
    const { object } = await hedged("generate", signal, (abortSignal) =>
      generateObject({
        abortSignal,
        maxRetries: 0,
        messages: withImageParts(input, images),
        model: gateway(model),
        ...fastCallOptions(model),
        schema: replySchema,
        system: withImages(REPLY_PROMPT, images),
      })
    );
    return object;
  },
  async ground({ articles, customer, question, reply, signal }) {
    const model = await resolveModel("kb");
    const { object } = await hedged("ground", signal, (abortSignal) =>
      generateObject({
        abortSignal,
        maxRetries: 0,
        model: gateway(model),
        prompt: JSON.stringify({
          articles: articleInput(articles),
          conversation: question,
          nextStep: nextStep(customer),
          promptFacts: promptFacts(customer),
          reply,
        }),
        ...fastCallOptions(model),
        schema: groundSchema,
        system: GROUND_PROMPT,
      })
    );
    return object;
  },
  images: loadImages,
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
    const { object } = await hedged("rewrite", signal, (abortSignal) =>
      generateObject({
        abortSignal,
        maxRetries: 0,
        model: gateway(model),
        prompt: question,
        ...fastCallOptions(model),
        schema: rewriteSchema,
        system: REWRITE_PROMPT,
      })
    );
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
  async select({ images, index, question, signal }) {
    const model = await resolveModel("kbSelect");
    const { object } = await hedged("select", signal, (abortSignal) =>
      generateObject({
        abortSignal,
        maxRetries: 0,
        // The listing comes first so the long, stable prefix can be cached.
        messages: withImageParts(
          `${index.map(indexLine).join("\n")}\n\nConversation:\n${question}`,
          images
        ),
        model: gateway(model),
        ...fastCallOptions(model),
        schema: selectSchema,
        system: SELECT_PROMPT,
      })
    );
    return object;
  },
};

/** One article as the selector reads it; the web app's metadata is the retrieval language. */
export function indexLine(article: KbIndex[number], n: number): string {
  const description = article.description
    ?.trim()
    .slice(0, MAX_DESCRIPTION_CHARS);
  const keywords = article.keywords?.slice(0, MAX_KEYWORDS).join(", ");
  return `${n + 1}. ${article.title} (${article.id})${description ? `: ${description}` : ""}${keywords ? ` [${keywords}]` : ""}`;
}

/**
 * The articles the previous reply cited, as a place to look first. They are
 * hints from outside this process, so only a same-origin docs slug survives,
 * the url is rebuilt from that slug alone, and a slug the index does not list
 * is dropped.
 */
export async function activeArticleHits(
  ask: WidgetAsk,
  signal: AbortSignal,
  deps: Pick<KbDeps, "index">
): Promise<{ title: string; url: string }[]> {
  const slugs = [
    ...new Set(
      (ask.activeArticles ?? [])
        .map((article) => helpArticleSlug(article.url))
        .filter((slug): slug is string => slug !== null)
    ),
  ].slice(0, MAX_ARTICLES);
  if (slugs.length === 0) {
    return [];
  }
  const index = await deps.index(signal).catch(() => null);
  return slugs
    .filter((slug) => !index || index.some((article) => article.id === slug))
    .map((slug) => ({
      title: index?.find((article) => article.id === slug)?.title ?? slug,
      url: new URL(`/docs/${slug}`, HELP_CENTER_BASE_URL).toString(),
    }));
}

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
  deps: KbDeps,
  images?: KbImage[],
  cited: string[] = []
): Promise<{ hits: { title: string; url: string }[]; via: string }> {
  try {
    const index = await deps.index(signal);
    if (index) {
      const citedNumbers = index.flatMap((article, n) =>
        cited.includes(article.id) ? [n + 1] : []
      );
      const { articles } = selectSchema.parse(
        await deps.select({
          images,
          index,
          question: citedNumbers.length
            ? `${question}\n\nArticles the previous reply cited: ${citedNumbers.join(", ")}`
            : question,
          signal,
        })
      );
      const direct = [
        ...new Set(
          articles.filter((pick) => pick.fit === "direct").map((pick) => pick.n)
        ),
      ]
        .map((n) => index[n - 1])
        .filter((article) => article !== undefined)
        .map((article) => ({
          title: article.title,
          url: new URL(`/docs/${article.id}`, HELP_CENTER_BASE_URL).toString(),
        }));
      // Picks that are all related mean nothing answers it: the writer gets no
      // articles and says it is not sure. Only an empty pick searches instead.
      if (articles.length > 0) {
        return {
          hits: direct,
          via: `index:${direct.length}/${articles.length}`,
        };
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
    message: stepsOnOwnLines(
      message
        .replace(/[ \t]+([.,;:!?])/gu, "$1")
        .replace(/[ \t]{2,}/gu, " ")
        .replace(/[ \t]+$/gmu, "")
    )
      .trim()
      .slice(0, MAX_ANSWER_CHARS),
  };
}

/**
 * The writer is asked for one step per line but sometimes runs a numbered list
 * into one paragraph. A run of "1. … 2. …" (at least two steps, counting up
 * from 1) gets a line break before each step; anything else is left alone.
 */
export function stepsOnOwnLines(text: string): string {
  const breaks: number[] = [];
  let next = 1;
  for (const match of text.matchAll(/(^|\s)(\d{1,2})\.[ \t]/gu)) {
    if (Number(match[2]) !== next) {
      continue;
    }
    next += 1;
    if (match[1] === " " || match[1] === "\t") {
      breaks.push(match.index);
    }
  }
  if (next < 3) {
    return text;
  }
  let out = text;
  for (const index of breaks.reverse()) {
    out = `${out.slice(0, index)}\n${out.slice(index + 1)}`;
  }
  return out;
}

/** The written reply with its citations. A reply that cites nothing is still a reply. */
function withSources(
  raw: z.infer<typeof replySchema>,
  articles: KbArticle[]
): KbAnswer {
  const answer = resolveCitations(raw.reply, articles);
  if (answer.citations.length > 0) {
    return answer;
  }
  // No markers in the text: the listed sources, if any, carry the attribution.
  const listed = [...new Set(raw.sources)].filter(
    (n) => articles[n - 1] !== undefined
  );
  return {
    ...answer,
    citations: listed.map((n, position) => ({
      n: position + 1,
      title: articles[n - 1].title.slice(0, 300),
      url: articles[n - 1].url,
    })),
  };
}

/**
 * The writer's reply after the check. It trims, never blocks: a check that
 * fails, times out or comes back empty sends the writer's reply as written.
 */
async function grounded(
  reply: string,
  question: string,
  articles: KbArticle[],
  customer: KbCustomer | undefined,
  signal: AbortSignal,
  deps: KbDeps,
  log: { conversationId: string; runId: string }
): Promise<{ replaced: boolean; reply: string }> {
  const startedAt = Date.now();
  const done = (outcome: string, text: string) => {
    logOpsEvent("widget.kb.ground", {
      ...log,
      message: `ms=${Date.now() - startedAt}`,
      outcome,
    });
    return { replaced: outcome === "replaced", reply: text };
  };
  try {
    const result = groundSchema
      .partial({ notSure: true, stillAnswers: true, unsupported: true })
      .parse(
        await deps.ground({
          articles,
          customer,
          question,
          reply,
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(GROUND_TIMEOUT_MS),
          ]),
        })
      );
    const checked = result.reply.trim();
    const notSure = result.notSure?.trim();
    // Trimming that removed the answer itself sends the check's short honest
    // reply rather than what is left (Fin's validate stage).
    if (result.stillAnswers === false && notSure) {
      return done("replaced", notSure);
    }
    if (!checked) {
      return done("fallback", reply);
    }
    return done(checked === reply.trim() ? "unchanged" : "changed", checked);
  } catch {
    return done("fallback", reply);
  }
}

/**
 * Retrieve, then the one writer. Always a reply: a technical failure, or a
 * writer that returns nothing, is a short fixed ask to send the message again.
 */
export async function answerFromHelpCenter(
  input: string | WidgetAsk,
  log: { conversationId: string; runId: string },
  deps: KbDeps = defaultKbDeps,
  customer?: KbCustomer
): Promise<KbAnswer> {
  const ask = toAsk(input);
  const question = renderTranscript(ask);
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
    const images =
      ask.images?.length && deps.images
        ? await deps.images(ask.images, signal).catch(() => [])
        : [];
    if (ask.images?.length) {
      mark(`images=${images.length}/${ask.images.length}`);
    }
    // Every message also reads what the previous reply cited, whatever the
    // router made of it: "where do i go from here?" with a screenshot scored 0.25
    // as a follow-up, was read without the buying guides it continued, and
    // missed. Never instead of a fresh retrieval: "and if the chat bubble is
    // missing?" answered from the ticket-status article alone. Fresh hits lead,
    // so the latest message outweighs the earlier citation.
    const [active, { hits: fresh, via }] = await Promise.all([
      activeArticleHits(ask, signal, deps),
      findArticles(
        question,
        signal,
        deps,
        images,
        (ask.activeArticles ?? []).flatMap(
          (article) => helpArticleSlug(article.url) ?? []
        )
      ),
    ]);
    // With the index, a previous citation reaches the writer only when the
    // selector picked it again as direct; keyword search still carries it over.
    const kept = via.startsWith("index")
      ? []
      : active
          .filter((hit) => !fresh.some((found) => found.url === hit.url))
          .slice(0, MAX_ACTIVE_ARTICLES);
    const picked = fresh.slice(0, MAX_ARTICLES - kept.length);
    mark(`active=${kept.length} find:${via}`);
    const articles = (
      await Promise.all(
        [...picked, ...kept].map((hit) => deps.read(hit.url, signal))
      )
    ).filter((article): article is KbArticle => article !== null);
    mark("read");
    const written = replySchema.parse(
      await deps.generate({
        articles,
        customer,
        images,
        question,
        recordingOffered: ask.recordingOffered,
        signal,
      })
    );
    mark("generate");
    const checked = written.reply.trim()
      ? await grounded(
          written.reply,
          question,
          articles,
          customer,
          signal,
          deps,
          log
        )
      : { replaced: false, reply: written.reply };
    // The honest replacement cites nothing, so the writer's sources do not ride along.
    const answer = withSources(
      {
        reply: checked.reply,
        sources: checked.replaced ? [] : written.sources,
      },
      articles
    );
    mark("ground");
    if (!answer.message) {
      throw new Error("empty_reply");
    }
    // Which articles were read and cited, on a line of their own: the answer's
    // line already fills most of the log's 200-character message.
    logOpsEvent("widget.kb.answer", {
      ...log,
      message: `read=${articles.map((article) => helpArticleSlug(article.url) ?? article.url).join(",")} cited=${answer.citations.map((hit) => helpArticleSlug(hit.url) ?? hit.url).join(",")}`,
      outcome: "articles",
    });
    finish(
      answer.citations.length > 0 ? "ok" : "uncited",
      `citations=${answer.citations.length} ${marks.join(" ")}`
    );
    return answer;
  } catch (error) {
    mark("failed");
    finish(
      "error",
      `${error instanceof Error ? error.message.slice(0, 100) : "unknown"} ${marks.join(" ")}`
    );
    return {
      citations: [],
      message:
        "Sorry, the help-center answer could not be loaded just now. Please try your message again.",
    };
  }
}
