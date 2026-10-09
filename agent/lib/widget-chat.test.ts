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
} from "./widget-chat.js";

const TRY_AGAIN = /try your message again/u;

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
