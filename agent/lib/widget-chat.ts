import { gateway, isStepCount, streamText, tool } from "ai";
import { z } from "zod";
import { getHelpArticleContent, HELP_CENTER_BASE_URL } from "./help-center.js";
import { fastCallOptions, resolveModel } from "./models.js";
import { logOpsEvent } from "./ops-log.js";
import {
  defaultKbDeps,
  grounded,
  hedged,
  type KbAnswer,
  type KbCustomer,
  renderTranscript,
  resolveCitations,
} from "./widget-kb.js";
import {
  PRODUCT_GUIDE,
  PRODUCT_GUIDE_ARTICLES,
} from "./widget-product-guide.js";
import { toAsk, type WidgetAsk } from "./widget-router.js";

/**
 * Prototype front-door chat (ENG-14932): one streamed model call that already
 * knows the product. The system prefix is the persona, the rules and the whole
 * product guide distilled from the help center, identical on every call so
 * provider prompt caching serves it; the conversation follows.
 *
 * @remarks
 * Behind WIDGET_CHAT=guide; without it the help-center writer in widget-kb.ts
 * answers. Like that lane it is ungated on purpose: its only inputs are the
 * customer's own conversation and public help-center text, and it has no
 * account data and no account tools. Keep it that way. With
 * WIDGET_CHAT_TOOL=1 it may read one public article by slug.
 */

export const chatGuideEnabled = () => process.env.WIDGET_CHAT === "guide";

const CHAT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_TOKENS = 900;
const MAX_TURNS = 12;
const MAX_TURN_CHARS = 2000;
const MAX_ARTICLE_CHARS = 8000;
const MAX_ANSWER_CHARS = 4000;
// {slug} or {slug: slug}, as the prompt and the guide write them.
const TRAILING_SLASH = /\/+$/u;
const SLUG_MARKER = /\{\s*(?:slug:\s*)?([a-z0-9][a-z0-9/_-]*)\s*\}/gu;

export const CHAT_PROMPT = `You are Foreman, Acquisity's support teammate in the in-app chat. You are friendly, warm and direct, like a knowledgeable colleague who knows the product inside out. You help customers find their way around Acquisity, understand what each feature does, and fix problems with clear guidance. Talk in the second person, in short paragraphs, and answer first, with no preamble and no sign-off. Write two or more steps as a numbered list, one step per line, never run together in a sentence.

Every message deserves a natural reply, whatever shape it takes:
- A greeting, thanks, reaction or small talk gets a short friendly reply with no product facts, and never repeats an earlier answer.
- "What can you do?" gets a short answer: you can explain how Acquisity works, show where things are, walk through setup step by step and help troubleshoot; you cannot see their account or make changes. Then invite their question.
- A vague message ("it's not working", "help") gets one short question about what they are trying to do or what they see.
- A message with several questions gets an answer to each, in order.
- Read typos and shorthand the way a person would and answer what they meant.
- When the latest message changes subject, follow the new subject. When it only makes sense with the earlier conversation ("and the second one?", "where is that?"), resolve it from the conversation.
- When the customer is frustrated or asks again, acknowledge it in a few words and try a different approach: never repeat your previous reply, and never ask for something the conversation already gave. When they report what they saw or did, accept it and give the next step.
- A question that is not about Acquisity at all gets a short friendly answer that you are here for Acquisity questions.

Your knowledge of Acquisity is the product guide below, distilled from the help center. Facts specific to Acquisity come only from it: where something is, what a feature or setting does, who can use it, steps, limits, plans and prices. Copy page, menu, button, tab and setting names exactly as the guide writes them, and give paths the way it does. Never invent a menu, label, setting, link, price or limit. After each sentence or step that uses the guide, put the slug of the article the fact came from in braces, like {cold-email-agent/campaigns/create-a-campaign}, once per step or paragraph. Use the slug from that article's own ### heading, the most specific one that states the fact, never the navigation map's or an overview's when a more specific article says it. When the guide says something is not available or not on every workspace, say so.

A tool, app, integration or kind of link that the guide does not name is not covered by what it says about other ones: never answer yes about it or give steps that use it; say you are not sure it works and give what the guide does say. Never state that Acquisity cannot do something, does not support it or has no such feature unless the guide says exactly that.

When the guide does not cover what they ask, including a feature it does not describe, say plainly that you do not know of a way to do that in Acquisity or that you are not sure, never that it is impossible or unsupported. If the guide has something close that would help, offer it. Then ask the one question that would help, or give the next step.

For a procedure, give every step the guide gives, in order, starting with how to reach the page, and keep every warning or lasting consequence. For troubleshooting, give the first one or two checks and ask what they see. Explaining what a term or feature means and how the pieces fit together is your job.

Refer to the AI Consultant, under the Chat toggle at the top of the left sidebar, only when the customer asks you to give advice or strategy, write or review their copy (what an email, message or offer should say, including how to word one), or assess their campaign performance; you do not do those yourself. Otherwise do not mention it.

You cannot see the customer's account, workspace, campaigns or billing: never say or suggest that you looked. You cannot make changes and nobody will make them for them, so give the steps for them to do. Never promise that you, a person, a teammate or the team will look into, pick up or follow up on this message: nobody is notified.

The app tells you, in a note before the conversation, the customer's role and whether they can start a workspace investigation. When the guide limits a page or action to some roles (billing to Owners, for example) and the customer's role is not one of them, say so and that a workspace owner or admin can do it, and do not give them steps they cannot complete. When canInvestigate is true and the guide does not settle a problem that depends on their own account, the next step can be the magnifying glass next to the message box: they tap it and send their message again to start a look into their workspace. Say it as something they do. Offer it at most once: when glassOffered is true, never mention it again. When canInvestigate is false, never mention the magnifying glass; they can ask a workspace owner or admin.

The customer can attach screenshots. A screenshot reaches you as a labelled reading made by an image model: treat it as what their screen showed, use it to place them in the steps toward what they are trying to do, and never describe anything the reading does not say. They cannot attach video here: never mention a recording option.

Speak in Acquisity's own terms: never name an outside service behind the product (such as a sending, email delivery or hosting provider) unless the customer named it first, and never give a web address; point to the page in the app instead.

Plain text only: no markdown, no headings, no asterisks, no em dashes. A numbered list puts each step on its own line, starting with its number and a full stop, such as "1. ".

${PRODUCT_GUIDE}`;

const TOOL_RULE =
  "You can call read_help_article with a slug from the guide when the customer needs exact click-by-click detail the guide leaves out. Most questions need no lookup; call it at most once.";

export interface ChatDeps {
  /** One model attempt: the streamed reply and when its first text arrived. */
  generate: (input: {
    messages: ChatMessage[];
    signal: AbortSignal;
  }) => Promise<ChatAttempt>;
}

interface ChatMessage {
  content: string;
  role: "assistant" | "system" | "user";
}

interface ChatAttempt {
  cachedTokens: number;
  inputTokens: number;
  model: string;
  text: string;
  toolCalls: number;
  ttftMs: number;
}

/** The app's facts about the customer, then the conversation as chat turns. */
export function chatMessages(
  ask: WidgetAsk,
  customer: KbCustomer | undefined
): ChatMessage[] {
  const turns = (ask.turns ?? [])
    .filter((turn) => turn.text.trim())
    .slice(-MAX_TURNS)
    .map((turn) => ({
      content: turn.text.trim().slice(0, MAX_TURN_CHARS),
      role:
        turn.role === "customer" ? ("user" as const) : ("assistant" as const),
    }));
  const note = {
    canInvestigate: customer?.canInvestigate ?? false,
    glassOffered: customer?.glassOffered ?? false,
    role: customer?.role ?? "unknown",
    workspace: customer?.workspace ?? "unknown",
  };
  return [
    {
      content: `Note from the app, not written by the customer: ${JSON.stringify(note)}`,
      role: "system",
    },
    ...turns,
    {
      content: [
        ask.latest,
        ...(ask.screenshots ?? []).map(
          (reading) => `Screenshot reading: ${reading}`
        ),
      ].join("\n\n"),
      role: "user",
    },
  ];
}

/** The {slug} markers as numbered citations; a slug the guide does not have is dropped. */
export function guideCitations(text: string): KbAnswer {
  const { articles, numbered } = numberSlugs(text);
  return resolveCitations(numbered, articles);
}

/** The reply with [n] markers, and the cited articles with their guide section as content. */
function numberSlugs(text: string) {
  const slugs: string[] = [];
  const numbered = text.replace(SLUG_MARKER, (_, slug: string) => {
    const clean = slug.replace(TRAILING_SLASH, "");
    if (!(clean in PRODUCT_GUIDE_ARTICLES)) {
      return "";
    }
    if (!slugs.includes(clean)) {
      slugs.push(clean);
    }
    return `[${slugs.indexOf(clean) + 1}]`;
  });
  const articles = slugs.map((slug) => ({
    content: guideSection(slug),
    title: PRODUCT_GUIDE_ARTICLES[slug] ?? slug,
    url: new URL(`/docs/${slug}`, HELP_CENTER_BASE_URL).toString(),
  }));
  return { articles, numbered };
}

/** The guide's availability notes, navigation map and limits: every path a reply may use. */
const GUIDE_MAP = {
  content: PRODUCT_GUIDE.slice(0, PRODUCT_GUIDE.indexOf("\n## Articles")),
  title: "Navigation map",
  url: new URL("/docs", HELP_CENTER_BASE_URL).toString(),
};

/** One article's section of the guide: its heading line to the next heading. */
function guideSection(slug: string): string {
  const start = PRODUCT_GUIDE.indexOf(`{slug: ${slug}}\n`);
  if (start < 0) {
    return "";
  }
  const from = PRODUCT_GUIDE.lastIndexOf("\n", start) + 1;
  const end = PRODUCT_GUIDE.indexOf("\n#", start);
  return PRODUCT_GUIDE.slice(from, end < 0 ? undefined : end).trim();
}

const readArticle = tool({
  description:
    "Read one Acquisity help-center article in full by the slug the guide gives it.",
  async execute({ slug }, { abortSignal }) {
    if (!(slug in PRODUCT_GUIDE_ARTICLES)) {
      return { error: "Only a slug from the guide can be read." };
    }
    const article = await getHelpArticleContent(
      new URL(`/docs/${slug}`, HELP_CENTER_BASE_URL).toString(),
      { signal: abortSignal }
    );
    return "error" in article
      ? { error: "That article could not be read." }
      : { content: article.content.slice(0, MAX_ARTICLE_CHARS) };
  },
  inputSchema: z.object({ slug: z.string().max(300) }),
});

export const defaultChatDeps: ChatDeps = {
  async generate({ messages, signal }) {
    const model =
      process.env.WIDGET_CHAT_MODEL ?? (await resolveModel("kbChat"));
    const withTool = process.env.WIDGET_CHAT_TOOL === "1";
    const startedAt = Date.now();
    let ttftMs = -1;
    const options = fastCallOptions(model);
    const result = streamText({
      abortSignal: signal,
      allowSystemInMessages: true,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      messages: [
        {
          content: withTool ? `${CHAT_PROMPT}\n\n${TOOL_RULE}` : CHAT_PROMPT,
          // The stable prefix: Anthropic caches up to this breakpoint, and the
          // gateway turns on caching for providers that need it asked.
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
          role: "system",
        },
        ...messages,
      ],
      model: gateway(model),
      providerOptions: {
        ...options.providerOptions,
        gateway: {
          ...(options.providerOptions as { gateway?: object }).gateway,
          caching: "auto",
        },
      },
      ...(withTool
        ? {
            prepareStep: ({ stepNumber }: { stepNumber: number }) =>
              stepNumber >= 1 ? { activeTools: [] } : undefined,
            stopWhen: isStepCount(2),
            tools: { read_help_article: readArticle },
          }
        : {}),
    });
    let text = "";
    for await (const delta of result.textStream) {
      if (ttftMs < 0 && delta.trim()) {
        ttftMs = Date.now() - startedAt;
      }
      text += delta;
    }
    const usage = await result.totalUsage;
    const steps = await result.steps;
    return {
      cachedTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
      inputTokens: usage.inputTokens ?? 0,
      model,
      text,
      toolCalls: steps.reduce((sum, step) => sum + step.toolCalls.length, 0),
      ttftMs,
    };
  },
};

/** One streamed reply from the guide. Always a reply: a failure is a short ask to send again. */
export async function answerFromGuide(
  input: string | WidgetAsk,
  log: { conversationId: string; runId: string },
  customer?: KbCustomer,
  signal?: AbortSignal,
  deps: ChatDeps = defaultChatDeps
): Promise<KbAnswer> {
  const ask = toAsk(input);
  const reader = customer && {
    ...customer,
    glassOffered: (ask.turns ?? []).some(
      (turn) =>
        turn.role === "assistant" && turn.text.includes("magnifying glass")
    ),
  };
  const startedAt = Date.now();
  const scoped = AbortSignal.any([
    AbortSignal.timeout(CHAT_TIMEOUT_MS),
    ...(signal ? [signal] : []),
  ]);
  try {
    const messages = chatMessages(ask, reader);
    const attempt = await hedged("chat", scoped, (abortSignal) =>
      deps.generate({ messages, signal: abortSignal })
    );
    const { articles, numbered } = numberSlugs(
      attempt.text.slice(0, MAX_ANSWER_CHARS * 2)
    );
    // WIDGET_CHAT_GROUND=1: the help-center lane's check, against the guide
    // sections the reply cites plus the guide's navigation map, trims
    // unsupported claims before it is sent.
    const checked =
      process.env.WIDGET_CHAT_GROUND === "1" && numbered.trim()
        ? await grounded(
            numbered,
            renderTranscript(ask),
            [...articles, GUIDE_MAP],
            reader,
            scoped,
            defaultKbDeps,
            log
          )
        : { replaced: false, reply: numbered };
    const answer = resolveCitations(
      checked.reply,
      checked.replaced ? [] : articles
    );
    if (!answer.message) {
      throw new Error("empty_reply");
    }
    logOpsEvent("widget.chat.answer", {
      ...log,
      message: `model=${attempt.model} ttft=${attempt.ttftMs} ms=${Date.now() - startedAt} in=${attempt.inputTokens} cached=${attempt.cachedTokens} tools=${attempt.toolCalls} citations=${answer.citations.length}`,
      outcome: answer.citations.length > 0 ? "ok" : "uncited",
    });
    return answer;
  } catch (error) {
    logOpsEvent("widget.chat.answer", {
      ...log,
      message: `${error instanceof Error ? error.message.slice(0, 100) : "unknown"} ms=${Date.now() - startedAt}`,
      outcome: "error",
    });
    return {
      citations: [],
      message:
        "Sorry, the answer could not be loaded just now. Please try your message again.",
    };
  }
}
