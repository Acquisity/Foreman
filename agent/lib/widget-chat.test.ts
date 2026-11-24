import assert from "node:assert/strict";
import { test } from "node:test";
import { simulateStreamingMiddleware, wrapLanguageModel } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import {
  answerFromGuide,
  chatGuideEnabled,
  chatMessages,
  customerWords,
  defaultChatDeps,
  guideCitations,
  guideFor,
} from "./widget-chat.js";
import { GUIDE_CITATION } from "./widget-guide-cache.js";
import { PRODUCT_GUIDE } from "./widget-product-guide.js";

const TRY_AGAIN = /try your message again/u;
const WHO_CAN = /\n## Who can do what\n([\s\S]*?)\n## /u;

test("SDK failures never log provider text or raw errors", async (t) => {
  const sentinel = "private-customer-sentinel";
  const errors = t.mock.method(console, "error", () => undefined);
  const info = t.mock.method(console, "info", () => undefined);
  const model = new MockLanguageModelV4({
    doStream: () =>
      Promise.resolve({
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [{ error: new Error(sentinel), type: "error" }],
          initialDelayInMs: null,
        }),
      }),
  });
  const answer = await answerFromGuide(
    "hi",
    { conversationId: "c", runId: "r" },
    undefined,
    undefined,
    { generate: (input) => defaultChatDeps.generate(input, model) }
  );
  assert.match(answer.message, TRY_AGAIN);
  assert.equal(errors.mock.callCount(), 0);
  const lines = info.mock.calls.map((call) => call.arguments.join(" "));
  assert.ok(lines.length > 0);
  assert.ok(lines.every((line) => !line.includes(sentinel)));
  assert.ok(
    lines.some((line) => line.includes('"event":"widget.chat.answer"'))
  );
});

test("a stream cut off by its token limit never sends the partial procedure", async (t) => {
  const info = t.mock.method(console, "info", () => undefined);
  const partial = "1. Open Settings.\n2. Delete";
  const model = wrapLanguageModel({
    middleware: simulateStreamingMiddleware(),
    model: new MockLanguageModelV4({
      doGenerate: {
        content: [{ text: partial, type: "text" }],
        finishReason: { raw: "length", unified: "length" },
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
          outputTokens: { reasoning: 0, text: 900, total: 900 },
        },
        warnings: [],
      },
    }),
  });
  const answer = await answerFromGuide(
    "How do I delete this?",
    { conversationId: "c", runId: "r" },
    undefined,
    undefined,
    { generate: (input) => defaultChatDeps.generate(input, model) }
  );
  assert.match(answer.message, TRY_AGAIN);
  assert.ok(!answer.message.includes(partial));
  assert.equal(answer.citations.length, 0);
  assert.ok(
    info.mock.calls.some((call) =>
      call.arguments.join(" ").includes("reason=incomplete_reply")
    )
  );
});

test("prototype keys are dropped as unknown citation slugs", () => {
  assert.deepEqual(guideCitations("Open it. {constructor}"), {
    citations: [],
    message: "Open it.",
  });
});

test("the guide lane answers unless WIDGET_CHAT is legacy", () => {
  assert.equal(chatGuideEnabled(undefined), true);
  assert.equal(chatGuideEnabled("guide"), true);
  assert.equal(chatGuideEnabled("legacy"), false);
});

test("guide slugs become numbered citations and unknown slugs are dropped", () => {
  const answer = guideCitations(
    "Open Members. {workspace-settings/members}\nThen invite. {slug: workspace-settings/members}\nBuy inboxes. {cold-email-agent/email-accounts/buying-inboxes} Nothing here. {not/a-real-slug}\nBoth. {slug: workspace-settings/members, cold-email-agent/email-accounts/buying-inboxes}"
  );
  assert.deepEqual(
    answer.citations.map((c) => c.url),
    [
      "https://app.acquisity.ai/docs/workspace-settings/members",
      "https://app.acquisity.ai/docs/cold-email-agent/email-accounts/buying-inboxes",
    ]
  );
  assert.ok(!answer.message.includes("{"));
  assert.ok(!answer.message.includes("not/a-real-slug"));
});

test("the conversation reaches the model as chat turns after the app's note", () => {
  const messages = chatMessages(
    {
      latest: "and the second one?",
      screenshots: ["Screen: Members page"],
      turns: [
        { role: "customer", text: "two options?" },
        { role: "assistant", text: "Search or import." },
      ],
    },
    { canInvestigate: false, role: "member", workspace: "w" }
  );
  assert.deepEqual(
    messages.map((m) => m.role),
    ["system", "user", "assistant", "user"]
  );
  assert.ok(messages[0].content.includes('"role":"member"'));
  assert.equal(
    messages.at(-1)?.content,
    "and the second one?\n\nScreenshot reading: Screen: Members page"
  );
});

test("the team's schedule reaches the guide writer in the app's note only when the server sent one", () => {
  const customer = { canInvestigate: false, role: "owner", workspace: "w" };
  const note =
    "The support team's hours, from the app, in Eastern Time: Monday–Friday: 9:00 AM–5:00 PM.";
  assert.ok(
    chatMessages(
      { latest: "when are you open?" },
      {
        ...customer,
        officeSchedule: note,
      }
    )[0].content.includes(note)
  );
  assert.ok(
    !chatMessages(
      { latest: "when are you open?" },
      customer
    )[0].content.includes("support team's hours")
  );
});

test("a failed model call is a short ask to send again", async () => {
  const answer = await answerFromGuide(
    "hi",
    { conversationId: "c", runId: "r" },
    undefined,
    undefined,
    {
      generate: () => Promise.reject(new Error("down")),
    }
  );
  assert.equal(answer.citations.length, 0);
  assert.match(answer.message, TRY_AGAIN);
});

test("the guide's own words never reach the customer", () => {
  assert.equal(
    customerWords(
      'Get here: In the left sidebar, click "Workflows". The guide says so; buy inboxes in the guide\'s page {canInvestigate}.'
    ),
    'In the left sidebar, click "Workflows". The help center says so; buy inboxes in the guide\'s page.'
  );
  assert.equal(
    customerWords(
      "Tap the magnifying glass and resend your message so we can investigate why it stalls. We can look into your workspace for you. Then check Leads."
    ),
    "Tap the magnifying glass and send your message again. Then check Leads."
  );
  const glass =
    "Tap the magnifying glass next to the message box and send your message again to have your account investigated.";
  assert.equal(customerWords(glass), glass);
});

test("the guide writer's ticket note replaces the no-notification rule while its default prompt stays identical", async () => {
  const { CHAT_PROMPT, chatPrompt } = await import("./widget-chat.js");
  assert.equal(chatPrompt(), CHAT_PROMPT);
  assert.ok(CHAT_PROMPT.includes("nobody is notified"));
  assert.ok(!chatPrompt(true).includes("nobody is notified"));
  assert.ok(chatPrompt(true).includes("Do not deny notification or follow-up"));
  assert.ok(chatPrompt(true).includes("do not introduce yourself"));
  const calls: Parameters<
    import("./widget-chat.js").ChatDeps["generate"]
  >[0][] = [];
  await answerFromGuide(
    "Where do I find the AI Consultant?",
    { conversationId: "c", runId: "r" },
    {
      canInvestigate: true,
      role: "owner",
      ticketFiling: true,
      workspace: "Company One",
    },
    undefined,
    {
      generate: (input) => {
        calls.push(input);
        return Promise.reject(new Error("mock"));
      },
    }
  );
  assert.equal(calls[0].ticketFiling, true);
  assert.ok(
    calls[0].messages[0].content.includes(
      "The app is filing this conversation's ticket"
    )
  );
});

const helpCenter = {
  featuresOff: [
    {
      feature: "deliverability",
      pages: [
        "cold-email-agent/deliverability",
        "cold-email-agent/deliverability/faq",
      ],
      title: "Deliverability",
    },
  ],
  viewer: "signed.help.viewer",
};

test("the guide drops the articles and summary lines for pages the customer's features hide", () => {
  const guide = [
    "## What Acquisity cannot do",
    "- Placement tests cannot be scheduled {cold-email-agent/deliverability}",
    "- Workspaces cannot be deleted {workspace-settings/general}",
    "- Both {cold-email-agent/deliverability} {workspace-settings/general}",
    "",
    "## Articles",
    "",
    "### Deliverability {slug: cold-email-agent/deliverability}",
    "- Inbox placement per provider.",
    "",
    "### FAQ {slug: cold-email-agent/deliverability/faq}",
    "- Test before launch.",
    "",
    "### General {slug: workspace-settings/general}",
    "- Rename the workspace.",
    "",
  ].join("\n");
  assert.equal(guideFor(new Set(), guide), guide);
  assert.equal(guideFor(new Set(["no-such-page"])), PRODUCT_GUIDE);
  assert.equal(
    guideFor(new Set(helpCenter.featuresOff[0].pages), guide),
    [
      "## What Acquisity cannot do",
      "- Workspaces cannot be deleted {workspace-settings/general}",
      "- Both {cold-email-agent/deliverability} {workspace-settings/general}",
      "",
      "## Articles",
      "",
      "### General {slug: workspace-settings/general}",
      "- Rename the workspace.",
      "",
    ].join("\n")
  );
});

test("the guide writer answers from the customer's guide, is told what is off, and never cites a hidden page", async () => {
  const { chatPrompt, CHAT_PROMPT } = await import("./widget-chat.js");
  const prompt = chatPrompt(undefined, {
    featuresOff: [
      {
        feature: "local_business_leads",
        pages: ["dashboard"],
        title: "Dashboard",
      },
    ],
    viewer: "v",
  });
  assert.ok(CHAT_PROMPT.includes("{slug: dashboard}"));
  assert.ok(!prompt.includes("{slug: dashboard}"));
  assert.equal(chatPrompt(undefined, undefined), CHAT_PROMPT);

  const generated: { system: string; view?: unknown }[] = [];
  const customer = {
    canInvestigate: false,
    helpCenter: {
      ...helpCenter,
      featuresOff: [{ ...helpCenter.featuresOff[0], pages: ["dashboard"] }],
    },
    role: "member",
    workspace: "w",
  };
  const answer = await answerFromGuide(
    "how am I doing?",
    { conversationId: "c", runId: "r" },
    customer,
    undefined,
    {
      generate: (input) => {
        generated.push({
          system: input.messages[0].content,
          view: input.view,
        });
        return Promise.resolve({
          cachedTokens: 0,
          inputTokens: 0,
          model: "m",
          text: "That is not turned on for your workspace. {dashboard} See {faq}.",
          ttftMs: 1,
        });
      },
    }
  );
  assert.equal(generated[0].view, customer.helpCenter);
  assert.ok(generated[0].system.includes('"featuresOff":["Deliverability"]'));
  assert.ok(generated[0].system.includes("not turned on for their workspace"));
  assert.ok(!generated[0].system.includes(helpCenter.viewer));
  assert.deepEqual(
    answer.citations.map((citation) => citation.url),
    ["https://app.acquisity.ai/docs/faq"]
  );
});

test("a member's role limits come from their own guide, never a hidden page", () => {
  // The guide is regenerated from the docs, so the line comes from whatever
  // guide this runs against: the first role limit citing exactly one page.
  const [line, slug] =
    (PRODUCT_GUIDE.match(WHO_CAN)?.[1] ?? "")
      .split("\n")
      .map((limit) => [
        limit,
        ...[...limit.matchAll(GUIDE_CITATION)].map((m) => m[1]),
      ])
      .find((cited) => cited[0].startsWith("- ") && cited.length === 2) ?? [];
  assert.ok(line && slug, "the guide has a role limit citing one page");
  const member = { canInvestigate: false, role: "member", workspace: "w" };
  const note = (
    featuresOff: { feature: string; pages: string[]; title: string }[]
  ) =>
    chatMessages(
      { latest: "who can use it?" },
      { ...member, helpCenter: { featuresOff, viewer: "v" } }
    )[0].content;
  assert.ok(note([]).includes(line));
  assert.ok(
    !note([
      {
        feature: "hidden_feature",
        pages: [slug],
        title: "Hidden feature",
      },
    ]).includes(line)
  );
});
