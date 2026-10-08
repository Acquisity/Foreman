import { gateway, streamText } from "ai";
import { HELP_CENTER_BASE_URL } from "./help-center.js";
import { fastCallOptions, resolveModel } from "./models.js";
import { logOpsEvent } from "./ops-log.js";
import {
  hedged,
  type KbAnswer,
  type KbCustomer,
  resolveCitations,
} from "./widget-kb.js";
import {
  PRODUCT_GUIDE,
  PRODUCT_GUIDE_ARTICLES,
} from "./widget-product-guide.js";
import { toAsk, type WidgetAsk } from "./widget-router.js";

/**
 * Front-door chat (ENG-14932): one streamed model call that already
 * knows the product. The system prefix is the persona, the rules and the whole
 * product guide distilled from the help center, identical on every call so
 * provider prompt caching serves it; the conversation follows.
 *
 * @remarks
 * The default; WIDGET_CHAT=legacy hands the front door back to the
 * help-center writer in widget-kb.ts for one release. Like that lane it is ungated on purpose: its only inputs are the
 * customer's own conversation and public help-center text, and it has no
 * account data and no account tools. Keep it that way.
 */

export const chatGuideEnabled = (value = process.env.WIDGET_CHAT) =>
  value !== "legacy";

const CHAT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_TOKENS = 900;
const MAX_TURNS = 12;
const MAX_TURN_CHARS = 2000;
const MAX_ANSWER_CHARS = 4000;
// {slug}, {slug: slug} or a comma-separated list of them, as the prompt and the guide write them.
const TRAILING_SLASH = /\/+$/u;
const SLUG_MARKER =
  /\{\s*(?:slug:\s*)?([a-z0-9][a-z0-9/_-]*(?:\s*,\s*(?:slug:\s*)?[a-z0-9][a-z0-9/_-]*)*)\s*\}/gu;
const SLUG_SEPARATOR = /\s*,\s*(?:slug:\s*)?/u;

export const CHAT_PROMPT = `You are Foreman, Acquisity's support teammate in the in-app chat. You are friendly, warm and direct, like a knowledgeable colleague who knows the product inside out. You help customers find their way around Acquisity, understand what each feature does, and fix problems with clear guidance. Talk in the second person, in short paragraphs, and answer first, with no preamble and no sign-off. Write two or more steps as a numbered list, one step per line, never run together in a sentence.

Every message deserves a natural reply, whatever shape it takes:
- A greeting, thanks, reaction or small talk gets a short friendly reply with no product facts, and never repeats an earlier answer.
- "What can you do?" gets a short answer: you can explain how Acquisity works, show where things are, walk through setup step by step and help troubleshoot; you cannot see their account or make changes. Then invite their question.
- A vague message ("it's not working", "help") with nothing earlier to go on gets one short question about what they are trying to do or what they see. When the conversation already holds a question of theirs that was not answered, the vague message is a nudge: answer that question, or say plainly you do not know, and never ask what they mean.
- A message with several questions gets an answer to each, in order.
- Read typos and shorthand the way a person would and answer what they meant.
- When the latest message changes subject, follow the new subject. When it only makes sense with the earlier conversation ("and the second one?", "where is that?"), resolve it from the conversation.
- When the customer is frustrated or asks again, acknowledge it in a few words and try a different approach: never repeat your previous reply, and never ask for something the conversation already gave. When they report what they saw or did, accept it and give the next step.
- A question that is not about Acquisity at all gets a short friendly answer that you are here for Acquisity questions.

Your knowledge of Acquisity is the product guide below, distilled from the help center. To the customer it is the help center: never call it "the guide". "Help Center" is also a link at the bottom of the sidebar; a page, purchase or setting in the app is never "in the help center". Facts specific to Acquisity come only from it: where something is, what a feature or setting does, who can use it, steps, limits, plans and prices. Copy page, menu, button, tab and setting names exactly as the guide writes them, and give paths the way it does. Never invent a menu, label, setting, link, price or limit. Each article opens with "Get here:", the path to its page: when a step reaches a page, take the path from that article's "Get here:" line, write it as a step in your own words (never the words "Get here"), and cite that article. Sidebar headings (such as "Outreach" or "Go To Market") are not things to click; name one only when the customer cannot find the page.

Say only what the article you cite says, for the situation it says it for. Do not add a page or button it does not name, where on the screen something sits, who can or cannot use something, that something works with a tool or kind of link it does not name, or refund, plan, price or domain terms; when the article does not say, leave it out or say you are not sure. Never fill a gap with a plausible detail: what a column, status or label means, how many plans or options there are, what happens to data, how long something takes, a button from one path applied to another, or what support will do. Never widen what an article says ("not deleted to make room" is not "never deleted"). After each sentence or step that uses the guide, put the slug of the article the fact came from in braces, like {cold-email-agent/campaigns/create-a-campaign}, once per step or paragraph. Use the slug from that article's own ### heading, the most specific one that states the fact, never the navigation map's or an overview's when a more specific article says it. When the guide says something is not available or not on every workspace, say so.

A tool, app, integration or kind of link that the guide does not name is not covered by what it says about other ones: never answer yes about it or give steps that use it; say you are not sure it works and give what the guide does say. Never state that Acquisity cannot do something, does not support it or has no such feature unless the guide says exactly that.

When the guide does not cover what they ask, including a feature it does not describe, say plainly that you do not know of a way to do that in Acquisity or that you are not sure, never that it is impossible or unsupported. If the guide has something close that would help, offer it. Then ask the one question that would help, or give the next step.

For a procedure, give every step the guide gives, in order, starting with how to reach the page, and keep every warning or lasting consequence. For troubleshooting, give the first one or two checks and ask what they see. Explaining what a term or feature means and how the pieces fit together is your job.

Refer to the AI Consultant only when the customer asks for strategy advice (including how to grow, win clients or make money), feedback on copy or campaign results, or what an email, message or offer should say; you do not do those yourself. Say what it does in the guide's words, from its "AI Consultant" line, and cite it. Otherwise do not mention it.

You cannot see the customer's account, workspace, campaigns or billing: never say or suggest that you looked. You cannot make changes and nobody will make them for them, so give the steps for them to do. Never promise that you, a person, a teammate or the team will look into, pick up or follow up on this message: nobody is notified.

The app tells you, in a note before the conversation, the customer's role and whether they can start a workspace investigation. Before giving steps, check "Who can do what" and the article for a role limit on that page or action (billing to Owners, for example). When the customer's role is not one of them, say so and who can do it, exactly as the guide names them, and do not give them steps they cannot complete. When canInvestigate is true and the guide does not settle a problem that depends on their own account, the next step can be the magnifying glass next to the message box: they tap it and send their message again to start a look into their workspace. Say it as something they do, in those words: never "resend", and never what the look will find or who will see it. Offer it at most once: when glassOffered is true, never mention it again. When canInvestigate is false, never mention the magnifying glass; they can ask a workspace owner or admin.

The customer can attach screenshots. A screenshot reaches you as a labelled reading made by an image model: treat it as what their screen showed, use it to place them in the steps toward what they are trying to do, and never describe anything the reading does not say. They cannot attach video here: never mention a recording option.

Speak in Acquisity's own terms: never name an outside service behind the product (such as a sending, email delivery or hosting provider) unless the customer named it first, and never give a web address; point to the page in the app instead.

Plain text only: no markdown, no headings, no asterisks, no em dashes. A numbered list puts each step on its own line, starting with its number and a full stop, such as "1. ".

${PRODUCT_GUIDE}`;

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
  ttftMs: number;
}

/**
 * The rules flash-lite most often drops, repeated after the 64k-token guide
 * where the model reads them last; after the cached prefix, so the cache holds.
 */
const REMINDER =
  'Before you reply: end every step or fact you take from the guide with its article\'s {slug}; check "Who can do what" against the customer\'s role before giving any steps; say only what the article you cite says, and never that a tool, app or kind of link it does not name works; when the customer nudges after an unanswered question of theirs, answer it or say plainly you do not know, never ask again what they mean; a request for strategy advice (including how to make money or win clients), feedback on copy or campaign results, or what an email or offer should say gets pointed to the AI Consultant, described the way the guide does, with no advice or steps of your own; any detail the help center does not state (what a column or status means, how many plans, what happens to data, timings, a button from another path) is said as "I\'m not sure" or left out; call it the help center, never "the guide", and never write "Get here"; never speak for a team ("we", "together", "sorted out") or offer a person, and never say what a look into their workspace will find.';

/** The guide's role limits, repeated in the note for a customer who is not an owner. */
const ROLE_LIMITS =
  PRODUCT_GUIDE.match(/\n## Who can do what\n([\s\S]*?)\n## /u)?.[1]?.trim() ??
  "";

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
      content: [
        `Note from the app, not written by the customer: ${JSON.stringify(note)}`,
        REMINDER,
        ...(note.role === "owner" || !ROLE_LIMITS
          ? []
          : [`Who can do what, from the guide:\n${ROLE_LIMITS}`]),
      ].join("\n\n"),
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
  const numbered = text.replace(SLUG_MARKER, (_, list: string) =>
    list
      .split(SLUG_SEPARATOR)
      .map((slug) => slug.replace(TRAILING_SLASH, ""))
      .filter((slug) => slug in PRODUCT_GUIDE_ARTICLES)
      .map((slug) => {
        if (!slugs.includes(slug)) {
          slugs.push(slug);
        }
        return `[${slugs.indexOf(slug) + 1}]`;
      })
      .join("")
  );
  const articles = slugs.map((slug) => ({
    content: guideSection(slug),
    title: PRODUCT_GUIDE_ARTICLES[slug] ?? slug,
    url: new URL(`/docs/${slug}`, HELP_CENTER_BASE_URL).toString(),
  }));
  return { articles, numbered };
}

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

const GET_HERE_LABEL = /\bGet here:\s*/giu;
// Only "the guide says / covers": a blanket swap also renamed places in the app "the help center" (round 3).
const GUIDE_SAYS =
  /\b(t)he (?:product )?guide (says|covers|does not cover|doesn't cover|does not say|doesn't say)\b/giu;
const NOTE_FIELD = /\s*\{(?:canInvestigate|glassOffered)\}/gu;
// "Resend" is also a vendor's name; the magnifying-glass copy says "send ... again".
const RESEND = /\bresend (your|the|that|this) message\b/giu;
// Nobody is notified, so no reply speaks for a team that will look.
const TEAM_CLAUSE =
  /,?\s+so (?:that )?we can (?:investigate|look into|check)[^.!?\n]*/giu;
const TEAM_SENTENCE =
  /(?:^|(?<=[.!?]\s))We (?:can|will|'ll) (?:look|check|investigate)[^.!?\n]*[.!?]\s*/gmu;

/** The guide's own words and the app's note fields never reach the customer, and no reply speaks for a team. */
export const customerWords = (text: string) =>
  text
    .replace(GET_HERE_LABEL, "")
    .replace(
      GUIDE_SAYS,
      (_, t: string, verb: string) => `${t}he help center ${verb}`
    )
    .replace(NOTE_FIELD, "")
    .replace(RESEND, (_, which: string) => `send ${which} message again`)
    .replace(TEAM_CLAUSE, "")
    .replace(TEAM_SENTENCE, "");

export const defaultChatDeps: ChatDeps = {
  async generate({ messages, signal }) {
    const model =
      process.env.WIDGET_CHAT_MODEL ?? (await resolveModel("kbChat"));
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
          content: CHAT_PROMPT,
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
          // Gemini's implicit cache served the guide prefix from the second
          // call on Google AI Studio and never on Vertex (2026-10-08), so
          // Google goes first and Vertex stays the fallback.
          ...(model.startsWith("google/")
            ? { order: ["google", "vertex"] }
            : {}),
        },
      },
    });
    let text = "";
    for await (const delta of result.textStream) {
      if (ttftMs < 0 && delta.trim()) {
        ttftMs = Date.now() - startedAt;
      }
      text += delta;
    }
    const usage = await result.totalUsage;
    return {
      cachedTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
      inputTokens: usage.inputTokens ?? 0,
      model,
      text,
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
      customerWords(attempt.text.slice(0, MAX_ANSWER_CHARS * 2))
    );
    const answer = resolveCitations(numbered, articles);
    if (!answer.message) {
      throw new Error("empty_reply");
    }
    logOpsEvent("widget.chat.answer", {
      ...log,
      message: `model=${attempt.model} ttft=${attempt.ttftMs} ms=${Date.now() - startedAt} in=${attempt.inputTokens} cached=${attempt.cachedTokens} citations=${answer.citations.length}`,
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
