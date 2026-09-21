import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { gate, redactableItems } from "./widget-egress.js";
import type { WidgetFindings } from "./widget-findings.js";
import { reviewWidgetFindings } from "./widget-review.js";

const findings: WidgetFindings = {
  confidence: "medium",
  facts: [
    {
      claim: "Payment for this order is unconfirmed.",
      entityIds: [],
      evidence: { ref: "", tool: "widget_billing_summary" },
    },
  ],
  needsHuman: true,
  recommendation: "Place a fresh order.",
  report: "Private team-only report",
};
const input = {
  findings,
  items: redactableItems(findings),
  question: "Was this paid?",
  scope,
};
const mock =
  (answers: unknown): typeof fetch =>
  (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "jev-latest");
    assert.equal(body.state.includes(findings.report), false);
    assert.ok(init?.signal);
    return Promise.resolve(Response.json({ answers }));
  };
const answer = (choice: string, confidence = 0.99) => ({ choice, confidence });

test("JEV removal uses existing gate plumbing and preserves billing handoff facts", async () => {
  const result = await gate(scope, input.question, findings, {
    compose: ({ findings: retained }) => {
      assert.equal(retained.recommendation, "");
      assert.equal(retained.needsHuman, true);
      assert.equal(retained.facts[0]?.claim, findings.facts[0]?.claim);
      return Promise.resolve("Payment for this order is unconfirmed.");
    },
    judge: (data) =>
      reviewWidgetFindings(data, {
        apiKey: "test",
        fetch: mock({ item_1: answer("keep"), item_2: answer("remove") }),
      }),
    resolve: async () => ({
      domains: new Set<string>(),
      emails: new Set<string>(),
      slugs: new Set<string>(),
      uuids: new Set<string>(),
    }),
  });
  assert.equal(result.decision, "rewrite");
  assert.equal(result.findings.needsHuman, true);
  assert.equal(result.message, "Payment for this order is unconfirmed.");
});

test("JEV keeps valid items, blocks uncertain ownership, and never treats low confidence as allow", async () => {
  await Promise.all(
    (
      [
        ["keep", 0.99, "allow"],
        ["block", 0.99, "block"],
        ["keep", 0.79, "block"],
      ] as const
    ).map(async ([choice, confidence, expected]) => {
      const result = await reviewWidgetFindings(input, {
        apiKey: "test",
        fetch: mock({
          item_1: answer(choice, confidence),
          item_2: answer("keep"),
        }),
      });
      assert.equal(result.decision, expected);
    })
  );
});

test("incomplete or invalid JEV classifications fail closed", async () => {
  await Promise.all(
    [
      { item_1: answer("keep") },
      { item_1: answer("keep"), item_3: answer("keep") },
      {
        item_1: answer("keep"),
        item_2: answer("keep"),
        item_3: answer("keep"),
      },
      { item_1: answer("invented"), item_2: answer("keep") },
      { item_1: { choice: "keep" }, item_2: answer("keep") },
    ].map((answers) =>
      assert.rejects(
        reviewWidgetFindings(input, { apiKey: "test", fetch: mock(answers) })
      )
    )
  );
});

test("missing credentials, transport failures and oversized context cannot allow a reply", async () => {
  await assert.rejects(reviewWidgetFindings(input, { apiKey: "" }));
  await assert.rejects(
    reviewWidgetFindings(input, {
      apiKey: "test",
      fetch: async () => new Response(null, { status: 503 }),
    })
  );
  await assert.rejects(
    reviewWidgetFindings(input, {
      apiKey: "test",
      fetch: () => Promise.reject(new Error("timeout")),
    })
  );
  await assert.rejects(
    reviewWidgetFindings(
      { ...input, question: "x".repeat(60_001) },
      { apiKey: "test" }
    )
  );
});
