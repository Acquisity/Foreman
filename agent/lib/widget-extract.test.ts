import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { extractWidgetFindings } from "./widget-extract.js";
import type { WidgetFindings } from "./widget-findings.js";

// What the small model returns: the lenient extraction shape.
const lenient = {
  confidence: "high",
  facts: [
    {
      claim: "The sending inbox is disconnected.",
      entityIds: [],
      evidenceRef: "row-1",
      evidenceTool: "widget_inbox_health",
    },
  ],
  needsHuman: false,
  recommendation: "Reconnect the inbox to resume sending.",
  report: "The inbox is disconnected; reconnect it and sending resumes.",
};
// What normalize should produce: the strict findings.
const expected: WidgetFindings = {
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

test("lenient model output normalizes to validated findings", async () => {
  const out = await extractWidgetFindings(input, {
    generate: () => Promise.resolve(lenient),
  });
  assert.deepEqual(out, expected);
});

test("a fact with no evidence tool defaults to 'investigation'", async () => {
  const out = await extractWidgetFindings(input, {
    generate: () =>
      Promise.resolve({
        facts: [{ claim: "A campaign is paused." }],
        recommendation: "Check it.",
        report: "Something is off.",
      }),
  });
  assert.equal(out?.facts[0].evidence.tool, "investigation");
  assert.deepEqual(out?.facts[0].entityIds, []);
});

test("empty/garbage model output returns null so the caller uses the prose", async () => {
  const out = await extractWidgetFindings(input, {
    generate: () => Promise.resolve({ facts: [] }),
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
        return Promise.resolve(lenient);
      },
    }
  );
  assert.equal(out, null);
  assert.equal(called, false);
});

test("a clarifying question is a normal reply, and only an explicit conclusion hands off to a person", async () => {
  const asked = await extractWidgetFindings(input, {
    generate: () =>
      Promise.resolve({
        facts: [],
        needsHuman: false,
        recommendation: "Could you tell me which campaign you mean?",
      }),
  });
  assert.equal(asked?.needsHuman, false);
  assert.deepEqual(asked?.facts, []);

  const stuck = await extractWidgetFindings(input, {
    generate: () =>
      Promise.resolve({
        facts: [],
        needsHuman: true,
        recommendation:
          "This needs a person: the workspace could not be verified.",
      }),
  });
  assert.equal(stuck?.needsHuman, true);
});
