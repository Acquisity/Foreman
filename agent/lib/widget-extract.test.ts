import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { extractWidgetFindings } from "./widget-extract.js";
import type { WidgetFindings } from "./widget-findings.js";

const valid: WidgetFindings = {
  confidence: "high",
  facts: [
    {
      claim: "The sending inbox is disconnected.",
      entityIds: [],
      evidence: { ref: "row-1", tool: "widget_inbox_health" },
    },
  ],
  needsHuman: false,
  recommendation: "Reconnect the inbox to resume sending.",
  report: "The inbox is disconnected; reconnect it and sending resumes.",
};
const input = {
  investigatorText: "The inbox disconnected, so nothing is going out.",
  question: "Why did my campaign stop sending?",
  scope,
};

test("valid prose becomes validated findings", async () => {
  const out = await extractWidgetFindings(input, {
    generate: () => Promise.resolve(valid),
  });
  assert.deepEqual(out, valid);
});

test("output that fails the findings schema returns null", async () => {
  const out = await extractWidgetFindings(input, {
    generate: () => Promise.resolve({ bad: true }),
  });
  assert.equal(out, null);
});

test("a generation error returns null and never throws", async () => {
  const out = await extractWidgetFindings(input, {
    generate: () => Promise.reject(new Error("model down")),
  });
  assert.equal(out, null);
});

test("empty investigator text returns null without calling the model", async () => {
  let called = false;
  const out = await extractWidgetFindings(
    { ...input, investigatorText: "   " },
    {
      generate: () => {
        called = true;
        return Promise.resolve(valid);
      },
    }
  );
  assert.equal(out, null);
  assert.equal(called, false);
});
