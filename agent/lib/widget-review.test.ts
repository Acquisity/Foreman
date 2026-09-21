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
  (reply: unknown): typeof fetch =>
  (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "jev-latest");
    assert.equal(body.state.includes(findings.report), false);
    assert.ok(init?.signal);
    return Promise.resolve(Response.json({ answers: reply }));
  };
const answer = (choice: string, confidence = 0.99) => ({ choice, confidence });
/** Every item owned, kept and material unless a test overrides one answer. */
const answers = (overrides: Record<string, unknown> = {}, count = 2) => ({
  ...Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      [`own_${index + 1}`, answer("owned")],
      [`item_${index + 1}`, answer("keep")],
      [`need_${index + 1}`, answer("material")],
    ]).flat()
  ),
  ...overrides,
});
const owned = {
  domains: new Set<string>(),
  emails: new Set<string>(),
  slugs: new Set<string>(),
  uuids: new Set<string>(),
};
const review = (
  overrides: Record<string, unknown>,
  log?: (l: string) => void
) =>
  reviewWidgetFindings(input, {
    apiKey: "test",
    fetch: mock(answers(overrides)),
    log: log ?? (() => undefined),
  });

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
        fetch: mock(
          answers({ item_2: answer("remove"), need_2: answer("dispensable") })
        ),
        log: () => undefined,
      }),
    resolve: async () => owned,
  });
  assert.equal(result.decision, "rewrite");
  assert.equal(result.findings.needsHuman, true);
  assert.equal(result.message, "Payment for this order is unconfirmed.");
});

test("a rewrite that deletes every fact of a handoff hands off instead of answering", async () => {
  const result = await gate(scope, input.question, findings, {
    compose: () => assert.fail("must not compose"),
    judge: () =>
      Promise.resolve({ decision: "rewrite", reason: "x", remove: [1] }),
    resolve: async () => owned,
  });
  assert.equal(result.decision, "block");
  assert.equal(result.reason, "needs_human");
});

test("decision policy separates wording doubt from ownership doubt", async () => {
  const cases: [Record<string, unknown>, string, string][] = [
    [{}, "allow", "jev:all_items_kept"],
    // Uncertain wording on a dispensable aside: deleted, the rest delivered.
    [
      { item_2: answer("keep", 0.6), need_2: answer("dispensable") },
      "rewrite",
      "jev:remove_items:2",
    ],
    // Uncertain wording alone never deletes: a caveat, or doubt it is dispensable.
    [
      { item_1: answer("remove", 0.6) },
      "block",
      "jev:uncertain_not_removable:1",
    ],
    [
      { item_2: answer("keep", 0.6), need_2: answer("dispensable", 0.7) },
      "block",
      "jev:uncertain_not_removable:2",
    ],
    // A confident violation that is a material caveat cannot be stripped.
    [{ item_1: answer("remove") }, "block", "jev:violation_not_removable:1"],
    // Ownership doubt blocks even when the item looks deletable.
    [
      { need_1: answer("dispensable"), own_1: answer("unsure") },
      "block",
      "jev:ownership_uncertain:1",
    ],
    [
      { need_1: answer("dispensable"), own_1: answer("owned", 0.79) },
      "block",
      "jev:ownership_uncertain:1",
    ],
    [
      { need_1: answer("dispensable"), own_1: answer("foreign", 0.79) },
      "block",
      "jev:ownership_uncertain:1",
    ],
    // Confidently foreign data is never shown: deleted, or blocked if material.
    [
      { need_2: answer("dispensable"), own_2: answer("foreign") },
      "rewrite",
      "jev:remove_items:2",
    ],
    [{ own_2: answer("foreign") }, "block", "jev:violation_not_removable:2"],
  ];
  for (const [overrides, decision, reason] of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: a failure names its case.
    const result = await review(overrides);
    assert.deepEqual([result.decision, result.reason], [decision, reason]);
  }
});

test("the review log carries verdicts and confidence, never customer text", async () => {
  const lines: string[] = [];
  await review(
    { item_2: answer("keep", 0.62), need_2: answer("dispensable", 0.91) },
    (line) => lines.push(line)
  );
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0] ?? "");
  assert.equal(record.event, "widget.review.items");
  assert.equal(record.code, "remove_items");
  assert.equal(record.decision, "rewrite");
  assert.equal(record.message, "2:owned.99/keep.62/dispensable.91");
  for (const secret of ["Payment", "fresh order", scope.organizationId]) {
    assert.equal(lines[0]?.includes(secret), false);
  }
});

test("incomplete or invalid JEV classifications fail closed", async () => {
  await Promise.all(
    [
      { item_1: answer("keep") },
      answers({ need_2: undefined }),
      answers({}, 3),
      answers({ own_3: answer("owned") }),
      answers({ item_1: answer("invented") }),
      answers({ item_1: { choice: "keep" } }),
      // A valid choice on the wrong question is malformed, not a verdict.
      answers({ own_1: answer("keep") }),
      answers({ need_1: answer("remove") }),
    ].map((body) =>
      assert.rejects(
        reviewWidgetFindings(input, { apiKey: "test", fetch: mock(body) })
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
