import assert from "node:assert/strict";
import { test } from "node:test";
import { composePrompt } from "./prompts.js";
import { sessionLane } from "./session-lane.js";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { COMPOSER_PROMPT } from "./widget-egress.js";
import { widgetInstructions, withoutGuide } from "./widget-instructions.js";
import { PRODUCT_GUIDE } from "./widget-product-guide.js";
import { widgetAuth } from "./widget-scope.js";

const FAILED_STEP_RULE =
  /already tried the documented step and it failed[^.]*recent reconnect attempts all failed, do not tell them to repeat that step or wait it out: state what failed, with its error, and set needsHuman true/;

test("a failed documented step is reported and handed to a person, never repeated", () => {
  assert.match(widgetInstructions(widgetAuth(scope)), FAILED_STEP_RULE);
});

test("the investigator and the composer carry the product guide, cached ahead of the scope, and the step-filler does not", () => {
  const prompt = composePrompt(sessionLane(widgetAuth(scope)));
  assert.ok(prompt.includes(PRODUCT_GUIDE));
  assert.ok(prompt.indexOf(PRODUCT_GUIDE) < prompt.indexOf(scope.userId));
  assert.ok(COMPOSER_PROMPT.endsWith(PRODUCT_GUIDE));
  const { prompt: stripped } = withoutGuide({
    prompt: [{ content: prompt, role: "system" }],
  });
  assert.ok(!String(stripped[0].content).includes(PRODUCT_GUIDE));
  assert.ok(String(stripped[0].content).includes(scope.userId));
});
