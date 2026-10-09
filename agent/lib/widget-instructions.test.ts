import assert from "node:assert/strict";
import { test } from "node:test";
import { composePrompt } from "./prompts.js";
import { sessionLane } from "./session-lane.js";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { CHAT_PROMPT } from "./widget-chat.js";
import { COMPOSER_PROMPT } from "./widget-egress.js";
import { WIDGET_VOICE, widgetInstructions } from "./widget-instructions.js";
import { PRODUCT_GUIDE } from "./widget-product-guide.js";
import { widgetAuth } from "./widget-scope.js";

const FAILED_STEP_RULE =
  /already tried the documented step and it failed[^.]*recent reconnect attempts all failed, do not tell them to repeat that step or wait it out: state what failed, with its error, and set needsHuman true/;
const NEXT_STEP_RULE =
  /ends with what the customer should do next: the steps[^.]*, the workaround for a[^.]*limitation, or the single most useful[^.]*check they can make/;
const STATED_FINDING_RULE =
  /a recorded count, status or absence[^;]*goes in the reply as stated, never replaced by saying it could not be confirmed or checked; what a live check could not show is said after it, never instead of it/;
const UNFILED_TICKET_RULE =
  /When ticketFiled is absent, nothing was reported[^.]*never say or suggest that this was reported, escalated or handed to engineering, billing or a person, even when the findings say it needs one/;

test("a failed documented step is reported and handed to a person, never repeated", () => {
  assert.match(widgetInstructions(widgetAuth(scope)), FAILED_STEP_RULE);
});

test("the composer carries the product guide and the investigator does not", () => {
  assert.ok(COMPOSER_PROMPT.endsWith(PRODUCT_GUIDE));
  const prompt = composePrompt(sessionLane(widgetAuth(scope)));
  assert.ok(!prompt.includes(PRODUCT_GUIDE));
  assert.ok(prompt.includes(scope.userId));
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
