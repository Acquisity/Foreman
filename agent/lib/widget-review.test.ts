import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import {
  type GateDeps,
  gate,
  redactableItems,
  removesLastCaveat,
} from "./widget-egress.js";
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
  needsHuman: false,
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
const FALLBACK_LOG = /^reviewer=fallback jev_ms=\d+ fallback_ms=\d+ 1:/u;
const SOFT_CODE = /^(?:uncertain_not_removable|ownership_low_confidence):1$/u;
const FAILED_LOG = / fallback_failed /u;
const JEV_LOG =
  /^reviewer=jev jev_ms=\d+ 2:owned\.99\/keep\.62\/dispensable\.91$/u;
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
  assert.equal(result.message, "Payment for this order is unconfirmed.");
});

test("a JEV-reviewed handoff returns its findings untouched and never composes", async () => {
  const handoff = { ...findings, needsHuman: true };
  const result = await gate(scope, input.question, handoff, {
    compose: () => assert.fail("must not compose"),
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
  assert.deepEqual(
    [result.decision, result.reason, result.findings],
    ["block", "needs_human", handoff]
  );
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
      "jev:ownership_low_confidence:1",
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
    [{ own_2: answer("foreign") }, "block", "jev:foreign_not_removable:2"],
    // An explicit ownership signal outranks an earlier item JEV is merely unsure of.
    [
      { item_1: answer("keep", 0.5), own_2: answer("unsure") },
      "block",
      "jev:ownership_uncertain:2",
    ],
  ];
  for (const [overrides, decision, reason] of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: a failure names its case.
    const result = await review(overrides);
    assert.deepEqual([result.decision, result.reason], [decision, reason]);
  }
});

// Shaped like the captured provisioning case: caveats the customer needs, plus
// one report that an internal source was unreadable. JEV's judgment is mocked,
// so this proves what the code does with each judgment, not which one JEV gives.
const overlap: WidgetFindings = {
  ...findings,
  facts: [
    ...findings.facts,
    {
      claim: "Whether the cancelled orders were charged cannot be settled.",
      entityIds: [],
      evidence: { ref: "", tool: "widget_provisioning_status" },
    },
    {
      claim: "The run trace behind each order is not readable.",
      entityIds: [],
      evidence: { ref: "", tool: "widget_provisioning_status" },
    },
  ],
  recommendation: "",
};
const gateOverlap = (overrides: Record<string, unknown>) => {
  let shown: string[] | undefined;
  return gate(scope, input.question, overlap, {
    compose: ({ findings: retained }) => {
      shown = retained.facts.map((fact) => fact.claim);
      return Promise.resolve("ok");
    },
    judge: (data) =>
      reviewWidgetFindings(data, {
        apiKey: "test",
        fetch: mock(answers(overrides, 3)),
        log: () => undefined,
      }),
    resolve: async () => owned,
  }).then((result) => ({ result, shown }));
};

test("an unreadable internal source is deleted only when the caveats stand without it", async () => {
  const caveats = overlap.facts.slice(0, 2).map((fact) => fact.claim);
  // Internal detail, other items carry the uncertainty: deleted, caveats shown.
  const removed = await gateOverlap({
    item_3: answer("remove"),
    need_3: answer("dispensable"),
  });
  assert.equal(removed.result.decision, "rewrite");
  assert.deepEqual(removed.shown, caveats);
  // A necessary limitation is kept word for word.
  const kept = await gateOverlap({});
  assert.equal(kept.result.decision, "allow");
  assert.equal(kept.shown?.length, 3);
  // The overlap: read as internal detail and as a needed caveat, or with doubt
  // on either question. Never shown, never stripped; the handoff keeps every fact.
  for (const overrides of [
    { item_3: answer("remove"), need_3: answer("material") },
    { item_3: answer("keep", 0.18), need_3: answer("material", 0.55) },
    { item_3: answer("remove"), need_3: answer("dispensable", 0.55) },
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: a failure names its case.
    const { result, shown } = await gateOverlap(overrides);
    assert.equal(result.decision, "block");
    assert.equal(shown, undefined);
    assert.equal(result.findings.facts.length, 3);
  }
});

// The live failures: valid answers JEV was unsure about (telemetry caveat at
// remove 0.36, "no failed runs" at keep 0.75, a known-issue caveat at owned 0.71,
// the unreadable run trace at remove 0.76 / dispensable 0.64), and unsafe advice
// JEV was sure about but would not call dispensable.
const withFallback = (
  overrides: Record<string, unknown>,
  fallback: NonNullable<Parameters<typeof reviewWidgetFindings>[1]>["fallback"],
  lines: string[] = []
) =>
  reviewWidgetFindings(input, {
    apiKey: "test",
    fallback,
    fetch: mock(answers(overrides)),
    log: (line) => lines.push(line),
  });
const allow = () =>
  Promise.resolve({ decision: "allow" as const, reason: "ok" });

test("JEV doubt goes to the existing reviewer once; confident and explicit verdicts never do", async () => {
  const soft = [
    { item_1: answer("remove", 0.36), need_1: answer("material", 0.06) },
    { item_1: answer("keep", 0.75), need_1: answer("material", 0.56) },
    { own_1: answer("owned", 0.71) },
    { item_1: answer("remove", 0.76), need_1: answer("dispensable", 0.64) },
  ];
  for (const overrides of soft) {
    let calls = 0;
    const lines: string[] = [];
    // biome-ignore lint/performance/noAwaitInLoops: a failure names its case.
    const result = await withFallback(
      overrides,
      (data, signal) => {
        calls += 1;
        assert.equal(data, input);
        assert.equal(signal.aborted, false);
        return allow();
      },
      lines
    );
    assert.equal(calls, 1);
    assert.equal(result.decision, "allow");
    const record = JSON.parse(lines[0] ?? "");
    assert.match(record.message, FALLBACK_LOG);
    assert.match(record.code, SOFT_CODE);
    assert.equal(lines[0]?.includes("Payment"), false);
  }
  const never = () => assert.fail("fallback must not run");
  for (const [overrides, reason] of [
    [{}, "jev:all_items_kept"],
    [
      { item_2: answer("remove"), need_2: answer("dispensable") },
      "jev:remove_items:2",
    ],
    [{ own_1: answer("unsure") }, "jev:ownership_uncertain:1"],
    [{ own_1: answer("foreign", 0.45) }, "jev:ownership_uncertain:1"],
    [{ own_1: answer("foreign") }, "jev:foreign_not_removable:1"],
    // One explicit ownership signal stops the fallback for the whole answer.
    [
      { item_1: answer("keep", 0.5), own_2: answer("unsure") },
      "jev:ownership_uncertain:2",
    ],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: a failure names its case.
    const result = await withFallback(overrides, never);
    assert.equal(result.reason, reason);
  }
});

test("the fallback can only add deletions, cannot keep a confident violation, and fails closed", async () => {
  // JEV confidently deleted item 2 and was unsure of item 1; the fallback allows.
  const merged = await withFallback(
    {
      item_1: answer("keep", 0.5),
      item_2: answer("remove"),
      need_2: answer("dispensable"),
    },
    allow
  );
  assert.deepEqual([merged.decision, merged.remove], ["rewrite", [2]]);
  // Unsafe advice JEV is sure of but will not call dispensable ("Place a fresh order").
  const violation = {
    item_2: answer("remove", 1),
    need_2: answer("dispensable", 0.5),
  };
  const removed = await withFallback(violation, () =>
    Promise.resolve({ decision: "rewrite", reason: "repurchase", remove: [2] })
  );
  assert.deepEqual([removed.decision, removed.remove], ["rewrite", [2]]);
  const kept = await withFallback(violation, allow);
  assert.deepEqual(
    [kept.decision, kept.reason],
    ["block", "jev:fallback_kept_violation:2"]
  );
  const blocks = await withFallback({ item_1: answer("keep", 0.5) }, () =>
    Promise.resolve({ decision: "block", reason: "foreign data" })
  );
  assert.equal(blocks.decision, "block");
  const lines: string[] = [];
  await assert.rejects(
    withFallback(
      { item_1: answer("keep", 0.5) },
      () => Promise.reject(new Error("timeout")),
      lines
    )
  );
  assert.match(JSON.parse(lines[0] ?? "").message, FAILED_LOG);
});

test("a fallback failure blocks at the gate, and a fallback answer keeps caveats and the handoff", async () => {
  const run = (fallback: Parameters<typeof withFallback>[1]) => {
    let shown: string[] | undefined;
    return gate(scope, input.question, overlap, {
      compose: ({ findings: retained }) => {
        shown = retained.facts.map((fact) => fact.claim);
        return Promise.resolve("ok");
      },
      judge: (data) =>
        reviewWidgetFindings(data, {
          apiKey: "test",
          fallback,
          fetch: mock(
            answers(
              {
                item_3: answer("remove", 0.76),
                need_3: answer("dispensable", 0.64),
              },
              3
            )
          ),
          log: () => undefined,
        }),
      resolve: async () => owned,
    }).then((result) => ({ result, shown }));
  };
  const failed = await run(() => Promise.reject(new Error("down")));
  assert.deepEqual(
    [failed.result.decision, failed.result.reason, failed.shown],
    ["block", "gate_unavailable", undefined]
  );
  const answered = await run(() =>
    Promise.resolve({ decision: "rewrite", reason: "internal", remove: [3] })
  );
  assert.equal(answered.result.decision, "rewrite");
  assert.deepEqual(
    answered.shown,
    overlap.facts.slice(0, 2).map((fact) => fact.claim)
  );
});

// The live fallback failures. The generation answer's only caveat was deleted as
// "internal telemetry"; whoever asks for that deletion, the remaining answer would
// claim a clean bill of health that was never verified, so the gate refuses it.
const twoItems = (claim: string, recommendation: string): WidgetFindings => ({
  ...findings,
  facts: [{ ...findings.facts[0], claim }] as WidgetFindings["facts"],
  recommendation,
});
const gateWith = (subject: WidgetFindings, judge: GateDeps["judge"]) => {
  let shown: string[] | undefined;
  return gate(scope, input.question, subject, {
    compose: ({ findings: retained }) => {
      shown = [
        ...retained.facts.map((fact) => fact.claim),
        retained.recommendation,
      ];
      return Promise.resolve("ok");
    },
    judge,
    resolve: async () => owned,
  }).then((result) => ({ result, shown }));
};

test("no reviewer, alone or combined, can delete the last statement of what is unconfirmed", async () => {
  const generation = twoItems(
    "No saved copy-review blocks were found in the last seven days.",
    "Model-call error telemetry was unavailable, so that part remains unknown."
  );
  const job = twoItems(
    "No failed runs were recorded in the last seven days.",
    "This does not establish that every job completed."
  );
  for (const subject of [generation, job]) {
    // The existing reviewer on its own.
    // biome-ignore lint/performance/noAwaitInLoops: a failure names its case.
    const direct = await gateWith(subject, () =>
      Promise.resolve({ decision: "rewrite", reason: "internal", remove: [2] })
    );
    assert.deepEqual(
      [direct.result.decision, direct.result.reason, direct.shown],
      ["block", "model_gate:removed_last_caveat", undefined]
    );
    // JEV unsure, the fallback deletes it: the combined set is refused too.
    const viaFallback = await gateWith(subject, (data) =>
      reviewWidgetFindings(data, {
        apiKey: "test",
        fallback: () =>
          Promise.resolve({
            decision: "rewrite",
            reason: "internal",
            remove: [2],
          }),
        fetch: mock(answers({ item_2: answer("remove", 0.36) })),
        log: () => undefined,
      })
    );
    assert.equal(viaFallback.result.reason, "model_gate:removed_last_caveat");
    // Kept, the product-job fact and its limit reach the customer word for word.
    const kept = await gateWith(subject, () =>
      Promise.resolve({ decision: "allow", reason: "ok" })
    );
    assert.deepEqual(kept.shown, [
      subject.facts[0]?.claim,
      subject.recommendation,
    ]);
  }
});

test("deletions spread across reviewers are judged by the answer that remains", async () => {
  // Payment uncertainty stated twice plus an aside. JEV confidently deletes one
  // statement, the fallback the other: each is fine alone, together they leave
  // only "the order is completed".
  const payment: WidgetFindings = {
    ...findings,
    facts: [
      "The order is completed.",
      "Payment for this order could not be confirmed.",
      "No record links the order to a charge, so attribution is unknown.",
    ].map((claim) => ({
      ...findings.facts[0],
      claim,
    })) as WidgetFindings["facts"],
    recommendation: "",
  };
  const run = (fallbackRemove: number[]) =>
    gateWith(payment, (data) =>
      reviewWidgetFindings(data, {
        apiKey: "test",
        fallback: () =>
          Promise.resolve({
            decision: "rewrite",
            reason: "x",
            remove: fallbackRemove,
          }),
        fetch: mock(
          answers(
            {
              item_1: answer("keep", 0.5),
              item_2: answer("remove"),
              need_2: answer("dispensable"),
            },
            3
          )
        ),
        log: () => undefined,
      })
    );
  const both = await run([3]);
  assert.equal(both.result.reason, "model_gate:removed_last_caveat");
  assert.equal(both.result.findings.facts.length, 3);
  // One statement of the uncertainty surviving is enough to answer.
  const one = await run([1]);
  assert.equal(one.result.decision, "rewrite");
  assert.deepEqual(one.shown, [payment.facts[2]?.claim, ""]);
});

test("the caveat check leaves ordinary rewrites alone", () => {
  const text = (...texts: string[]) => texts.map((t) => ({ text: t }));
  const caveat = "Whether it was charged cannot be settled.";
  assert.equal(
    removesLastCaveat(
      text("Three inboxes are live.", "Buy again."),
      text("Three inboxes are live.")
    ),
    false
  );
  assert.equal(
    removesLastCaveat(
      text("Three inboxes are live.", caveat),
      text("Three inboxes are live.")
    ),
    true
  );
  assert.equal(
    removesLastCaveat(
      text(caveat, "The run trace is not readable."),
      text(caveat)
    ),
    false
  );
});

test("a list marker stays with its step instead of becoming a claim of its own", () => {
  const items = redactableItems({
    ...findings,
    recommendation:
      "Check your inboxes: 1. Open Email Accounts. 2. Filter by 'Has Errors'. 3) Click Reconnect. You have 5 accounts. Paid in 2026. Done.",
  }).filter((item) => item.kind === "recommendation");
  assert.deepEqual(
    items.map((item) => item.text),
    [
      "Check your inboxes: 1. Open Email Accounts.",
      "2. Filter by 'Has Errors'.",
      "3) Click Reconnect.",
      "You have 5 accounts.",
      "Paid in 2026.",
      "Done.",
    ]
  );
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
  assert.equal(record.code, "remove_items:2");
  assert.equal(record.decision, "rewrite");
  assert.match(record.message, JEV_LOG);
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

test("the fallback gets only what is left of the judge budget after JEV", async (t) => {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  t.mock.method(Date, "now", () => realNow() + offset);
  const jevFetch = mock(answers({ item_1: answer("keep", 0.5) }));
  const seen: boolean[] = [];
  const fallback = async (_data: unknown, signal: AbortSignal) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    seen.push(signal.aborted);
    return { decision: "allow" as const, reason: "ok" };
  };
  for (const elapsed of [0, 61_000]) {
    // biome-ignore lint/performance/noAwaitInLoops: each run sets its own clock.
    await reviewWidgetFindings(input, {
      apiKey: "test",
      fallback,
      fetch: (url, init) => {
        offset = elapsed;
        return jevFetch(url, init);
      },
      log: () => undefined,
    }).catch(() => undefined);
  }
  assert.deepEqual(seen, [false, true]);
});
