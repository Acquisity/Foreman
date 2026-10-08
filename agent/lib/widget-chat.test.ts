import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerFromGuide,
  chatGuideEnabled,
  chatMessages,
  customerWords,
  guideCitations,
} from "./widget-chat.js";

const TRY_AGAIN = /try your message again/u;

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
});
