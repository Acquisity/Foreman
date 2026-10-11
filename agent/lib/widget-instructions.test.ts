import assert from "node:assert/strict";
import { test } from "node:test";
import { composePrompt } from "./prompts.js";
import { sessionLane } from "./session-lane.js";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { CHAT_PROMPT } from "./widget-chat.js";
import { COMPOSER_PROMPT, composerRequest } from "./widget-egress.js";
import {
  cacheGuide,
  WIDGET_VOICE,
  widgetInstructions,
  withoutGuide,
} from "./widget-instructions.js";
import { PRODUCT_GUIDE } from "./widget-product-guide.js";
import { widgetAuth } from "./widget-scope.js";
import { SUPPORT_GUIDE } from "./widget-support-guide.js";

const FAILED_STEP_RULE =
  /already tried the documented step and it failed[^.]*recent reconnect attempts all failed, do not tell them to repeat that step or wait it out: state what failed, with its error, and set needsHuman true/;
const NEXT_STEP_RULE =
  /ends with what the customer should do next: the steps[^.]*, the workaround for a[^.]*limitation, or the single most useful[^.]*check they can make/;
const STATED_FINDING_RULE =
  /a recorded count, status or absence[^;]*goes in the reply as stated, never replaced by saying it could not be confirmed or checked; what a live check could not show is said after it, never instead of it/;
const NO_INVENTION_RULES = [
  /Never explain why data is missing unless/,
  /never offer a service, migration or team action/,
  /never promise to report[^.]* it later/,
];
const UNFILED_TICKET_RULE =
  /When ticketFiled is absent, nothing was reported[^.]*never say or suggest that this was reported, escalated or handed to engineering, billing or a person, even when the findings say it needs one/;

test("both lanes forbid unbacked reasons for missing data, invented services and report promises", () => {
  // Round 9: "may have been cleared when the subscription was cancelled",
  // "ask for that here in the chat" to move domains, "I'll report it to engineering".
  for (const prompt of [
    composePrompt(sessionLane(widgetAuth(scope))),
    COMPOSER_PROMPT,
  ]) {
    for (const rule of NO_INVENTION_RULES) {
      assert.match(prompt, rule);
    }
  }
});

test("a failed documented step is reported and handed to a person, never repeated", () => {
  assert.match(widgetInstructions(widgetAuth(scope)), FAILED_STEP_RULE);
});

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

const user = (text: string) => ({
  content: [{ text, type: "text" }],
  role: "user",
});
const investigator = (userId: string, question: string) =>
  cacheGuide<{ content: unknown; role: string }>([
    {
      content: composePrompt(sessionLane(widgetAuth({ ...scope, userId }))),
      role: "system",
    },
    user(question),
  ]);

test("the investigator leads the first user message with the cached guide, the same for every question and workspace", () => {
  const [first, second] = [
    investigator(A, "Why was I charged?"),
    investigator(B, "My campaign stopped sending"),
  ];
  for (const [prompt, userId] of [
    [first, A],
    [second, B],
  ] as const) {
    assert.ok(!String(prompt[0].content).includes(PRODUCT_GUIDE));
    assert.ok(String(prompt[0].content).includes(userId));
  }
  const [guide] = first[1].content as {
    providerOptions?: unknown;
    text: string;
  }[];
  assert.deepEqual(guide, (second[1].content as unknown[])[0]);
  assert.ok(guide.text.endsWith(SUPPORT_GUIDE));
  assert.deepEqual(guide.providerOptions, {
    anthropic: { cacheControl: { type: "ephemeral" } },
  });
});

test("the step-filler's prompt carries no guide", () => {
  const { prompt } = withoutGuide({ prompt: investigator(A, "Why?") });
  assert.ok(!JSON.stringify(prompt).includes(PRODUCT_GUIDE));
  assert.deepEqual(prompt[1], user("Why?"));
});

test("every composer reply shares one cached guide-first prefix and keeps the guide out of system", () => {
  const [first, second] = [
    composerRequest({
      findings: { facts: [] },
      question: "Why was I charged?",
    }),
    composerRequest({ findings: { facts: [1] }, question: "Is my inbox ok?" }),
  ];
  assert.ok(!first.system.includes(PRODUCT_GUIDE));
  assert.equal(first.system, second.system);
  const [guide, rest] = first.messages[0].content;
  assert.deepEqual(guide, second.messages[0].content[0]);
  assert.equal(guide.text, SUPPORT_GUIDE);
  assert.ok(guide.providerOptions);
  assert.ok(rest.text.includes("Why was I charged?"));
});

test("the chat and the reply composer share one voice", () => {
  assert.ok(CHAT_PROMPT.includes(WIDGET_VOICE));
  assert.ok(COMPOSER_PROMPT.includes(WIDGET_VOICE));
  assert.ok(!COMPOSER_PROMPT.includes("No greetings"));
});

test("without a filed ticket the composer never says it was reported", () => {
  assert.match(COMPOSER_PROMPT, UNFILED_TICKET_RULE);
});

test("the write-up and the reply both end with what the customer does next", () => {
  assert.match(COMPOSER_PROMPT, NEXT_STEP_RULE);
  assert.match(widgetInstructions(widgetAuth(scope)), NEXT_STEP_RULE);
});

test("the composer reports a stated finding, never as could not confirm", () => {
  assert.match(COMPOSER_PROMPT, STATED_FINDING_RULE);
});
