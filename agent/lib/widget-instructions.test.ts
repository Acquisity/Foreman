import assert from "node:assert/strict";
import { test } from "node:test";
import { composePrompt } from "./prompts.js";
import { sessionLane } from "./session-lane.js";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { COMPOSER_PROMPT } from "./widget-egress.js";
import {
  cacheGuide,
  widgetInstructions,
  withoutGuide,
} from "./widget-instructions.js";
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

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

test("two workspaces share one cached system block that ends with the guide", () => {
  const split = (userId: string) =>
    cacheGuide([
      {
        content: composePrompt(sessionLane(widgetAuth({ ...scope, userId }))),
        role: "system",
      },
    ]);
  const [first, second] = [split(A), split(B)];
  assert.deepEqual(first[0], second[0]);
  assert.ok(String(first[0]?.content).endsWith(PRODUCT_GUIDE));
  assert.deepEqual(first[0]?.providerOptions, {
    anthropic: { cacheControl: { type: "ephemeral" } },
  });
  assert.ok(String(first[1]?.content).includes(A));
});
