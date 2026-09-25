import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import {
  defaultExtractDeps,
  extractWidgetFindings,
  filedTicket,
} from "./widget-extract.js";
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

test("a filed ticket is read from the closing line; a ticket merely mentioned is not", () => {
  assert.deepEqual(
    filedTicket(
      "Report: orders never provisioned. Related to ENG-14065.\nTicket filed: ENG-14067 https://linear.app/acquisity/issue/ENG-14067/pre-warmed\n"
    ),
    {
      id: "ENG-14067",
      url: "https://linear.app/acquisity/issue/ENG-14067/pre-warmed",
    }
  );
  assert.equal(filedTicket("Engineering ticket filed. See ENG-14065."), null);
  assert.equal(
    filedTicket(
      "Ticket filed: ENG-1 https://linear.app/acquisity/issue/ENG-2/x"
    ),
    null
  );
});

test("a billing review hands off with its facts and unresolved questions intact", async () => {
  const out = await extractWidgetFindings(input, {
    generate: () =>
      Promise.resolve({
        ...lenient,
        needsHuman: true,
        recommendation:
          "Unresolved: whether the second charge belongs to this workspace.",
      }),
  });
  assert.equal(out?.needsHuman, true);
  assert.deepEqual(out?.facts, expected.facts);
  assert.equal(out?.recommendation.includes("second charge"), true);
});

test("the default extractor runs under a deadline, so a stalled call hands the write-up to a person", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  const realFetch = globalThis.fetch;
  const realKey = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "test";
  globalThis.fetch = ((request: RequestInfo | URL, init?: RequestInit) => {
    if (
      String(request instanceof Request ? request.url : request).includes(
        "ai-gateway"
      )
    ) {
      signals.push(init?.signal);
    }
    return Promise.resolve(new Response("{}", { status: 400 }));
  }) as typeof fetch;
  try {
    await assert.rejects(
      defaultExtractDeps.generate({
        investigatorText: "The sending inbox is disconnected.",
        question: "Why did my campaign stop?",
        scope,
      })
    );
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) {
      delete process.env.AI_GATEWAY_API_KEY;
    } else {
      process.env.AI_GATEWAY_API_KEY = realKey;
    }
  }
  assert.equal(signals.length, 1);
  assert.ok(signals[0] instanceof AbortSignal);
});
