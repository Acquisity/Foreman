import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import {
  composerInput,
  extractIdentifiers,
  type GateDeps,
  gate,
  redactableItems,
  removeItems,
} from "./widget-egress.js";
import { buildOwnershipQuery } from "./widget-evidence.js";
import type { WidgetFindings } from "./widget-findings.js";

const RECONNECT = /Reconnect/;
const INTERNAL = /^internal_artifact:/;
const EMAIL_LITERAL = /'\{someone@example\.com\}'::text\[\]/;

const campaignId = "44444444-4444-4444-8444-444444444444";
const foreignId = "55555555-5555-4555-8555-555555555555";
const findings = (overrides: Partial<WidgetFindings> = {}): WidgetFindings => ({
  confidence: "medium",
  facts: [
    {
      claim: `Campaign ${campaignId} paused on 2026-09-10 after its inbox disconnected.`,
      entityIds: [campaignId],
      evidence: {
        ref: "outreach_campaign_activity:row-1",
        tool: "planetscale_execute_read_query",
      },
    },
  ],
  needsHuman: false,
  recommendation:
    "Reconnect the inbox from the email accounts page, then resume the campaign.",
  report:
    "The campaign paused because the sending inbox disconnected. Ask the customer to reconnect it, then resume the campaign.",
  ...overrides,
});
const question = "Why did my campaign stop sending?";

function deps(overrides: Partial<GateDeps> = {}) {
  const calls = {
    compose: [] as unknown[],
    judge: [] as unknown[],
    resolve: [] as unknown[],
  };
  const base: GateDeps = {
    compose: (input) => {
      calls.compose.push(input);
      return Promise.resolve(
        "Your campaign paused because its inbox disconnected. Reconnect it, then resume."
      );
    },
    judge: (input) => {
      calls.judge.push(input);
      return Promise.resolve({ decision: "allow", reason: "in scope" });
    },
    resolve: (_scope, candidates) => {
      calls.resolve.push(candidates);
      return Promise.resolve({
        emails: new Set<string>(),
        slugs: new Set<string>(),
        uuids: new Set([campaignId]),
      });
    },
  };
  return { calls, deps: { ...base, ...overrides } };
}

test("own-workspace identifiers pass and the composer sees no evidence references", async () => {
  const { calls, deps: d } = deps();
  const result = await gate(scope, question, findings(), d);
  assert.equal(result.decision, "allow");
  assert.match(result.message ?? "", RECONNECT);
  assert.deepEqual(calls.resolve, [
    { emails: [], slugs: [], uuids: [campaignId] },
  ]);
  const [composed] = calls.compose as { findings: unknown }[];
  assert.deepEqual(composed.findings, composerInput(findings()));
  assert.equal(JSON.stringify(composed).includes("planetscale"), false);
  assert.equal(JSON.stringify(composed).includes("row-1"), false);
});

test("a foreign identifier blocks before any model call", async () => {
  const { calls, deps: d } = deps();
  const result = await gate(
    scope,
    question,
    findings({
      recommendation: `Another customer ${foreignId} fixed this by reconnecting.`,
    }),
    d
  );
  assert.equal(result.decision, "block");
  assert.equal(result.reason, `foreign_identifier:${foreignId}`);
  assert.equal(result.message, null);
  assert.equal(calls.judge.length, 0);
  assert.equal(calls.compose.length, 0);
});

for (const [label, text] of [
  [
    "a Sentry link",
    "See https://acquisity.sentry.io/issues/12345 for the trace.",
  ],
  ["an Inngest run id", "Run 01J8ZQ3K4M5N6P7Q8R9S0T1V2W failed twice."],
  ["a stack trace", "It threw:\n    at sendCampaign (campaign.ts:12:5)"],
  ["another Linear ticket", "Tracked in ENG-13999 and ENG-12140."],
  ["an unknown domain", "Your inbox at mail.example-sender.com bounced."],
] as const) {
  test(`${label} in a claim blocks without resolving identifiers`, async () => {
    const { calls, deps: d } = deps();
    const result = await gate(
      scope,
      question,
      findings({ recommendation: text }),
      d
    );
    assert.equal(result.decision, "block");
    assert.match(result.reason, INTERNAL);
    assert.equal(calls.resolve.length, 0);
    assert.equal(calls.judge.length, 0);
  });
}

test("the findings' own ticket and public help links are not internal artifacts", () => {
  const { internal } = extractIdentifiers(
    findings({
      recommendation:
        "Tracked in ENG-13999; see https://help.acquisity.ai/campaigns.",
      ticket: {
        id: "ENG-13999",
        url: "https://linear.app/acquisity/issue/ENG-13999",
      },
    })
  );
  assert.deepEqual(internal, []);
});

test("a claim with no evidence reference is judged by the model gate, not blocked deterministically", async () => {
  // Backing is now the model gate's call: the prose->extract flow can't restate
  // a ref per fact, so an empty ref must not deterministically block. The
  // deterministic layer owns cross-tenant identifiers only.
  const { calls, deps: d } = deps();
  const noRef = findings();
  noRef.facts[0].evidence.ref = " ";
  const result = await gate(scope, question, noRef, d);
  assert.equal(result.decision, "allow");
  assert.equal(calls.judge.length, 1);
});

test("needsHuman with concrete facts still answers the customer and flags CS separately", async () => {
  const { calls, deps: d } = deps();
  const result = await gate(scope, question, findings({ needsHuman: true }), d);
  assert.equal(result.decision, "allow");
  assert.match(result.message ?? "", RECONNECT);
  assert.equal(calls.compose.length, 1);
});

test("needsHuman with no concrete facts hands off with no reply", async () => {
  const { calls, deps: d } = deps();
  const raw = findings({ facts: [], needsHuman: true });
  const result = await gate(scope, question, raw, d);
  assert.deepEqual(
    [result.decision, result.reason, result.message],
    ["block", "needs_human", null]
  );
  assert.deepEqual(result.findings, raw);
  assert.equal(calls.compose.length, 0);
});

test("a composed message that leaks a foreign identifier is blocked after composition", async () => {
  const { deps: d } = deps({
    compose: () => Promise.resolve(`See workspace ${foreignId} for details.`),
  });
  const result = await gate(scope, question, findings(), d);
  assert.equal(result.decision, "block");
  assert.match(result.reason, /^composed:foreign_identifier:/);
  assert.equal(result.message, null);
});

test("a composed message that leaks an internal host is blocked after composition", async () => {
  const { deps: d } = deps({
    compose: () =>
      Promise.resolve(
        "See https://acquisity.sentry.io/issues/1 for the trace."
      ),
  });
  const result = await gate(scope, question, findings(), d);
  assert.equal(result.decision, "block");
  assert.match(result.reason, /^composed:internal_artifact:/);
  assert.equal(result.message, null);
});

test("a model block, an invalid rewrite, and a gate outage all fail closed", async () => {
  const blocked = deps({
    judge: () =>
      Promise.resolve({ decision: "block", reason: "mentions staff" }),
  });
  assert.equal(
    (await gate(scope, question, findings(), blocked.deps)).reason,
    "model_gate:mentions staff"
  );
  const invalid = deps({
    judge: () =>
      Promise.resolve({
        decision: "rewrite",
        reason: "trimmed",
        remove: [99],
      }),
  });
  assert.equal(
    (await gate(scope, question, findings(), invalid.deps)).reason,
    "model_gate:invalid_rewrite"
  );
  const outage = deps({
    resolve: () => Promise.reject(new Error("executor down")),
  });
  assert.equal(
    (await gate(scope, question, findings(), outage.deps)).reason,
    "gate_unavailable"
  );
});

test("a rewrite deletes the numbered items, is re-checked, and is composed from what is left", async () => {
  const twoFacts = findings({
    facts: [
      ...findings().facts,
      {
        claim: "An engineer saw a related error in the logging dashboard.",
        entityIds: [],
        evidence: { ref: "", tool: "investigation" },
      },
    ],
  });
  const seen: unknown[] = [];
  const { calls, deps: d } = deps({
    judge: (input) => {
      seen.push(input.items);
      return Promise.resolve({
        decision: "rewrite",
        reason: "dropped internal detail",
        remove: [2],
      });
    },
  });
  const result = await gate(scope, question, twoFacts, d);
  assert.equal(result.decision, "rewrite");
  // The judge saw every customer-visible part, numbered.
  assert.deepEqual(
    (seen[0] as { kind: string; n: number }[]).map((i) => [i.n, i.kind]),
    [
      [1, "fact"],
      [2, "fact"],
      [3, "recommendation"],
    ]
  );
  // Only the named fact is gone; the rest is the investigator's text, untouched.
  assert.deepEqual(result.findings.facts, findings().facts);
  assert.equal(result.findings.recommendation, twoFacts.recommendation);
  assert.deepEqual(
    (calls.compose[0] as { findings: unknown }).findings,
    composerInput(result.findings)
  );
});

test("redaction can only delete: sentences, facts and the needed change, never reword", () => {
  const base = findings({
    needsWrite: "Raise the plan limit.",
    recommendation:
      "Reconnect the inbox. Ask Dave in ops to check. Then resume.",
  });
  assert.deepEqual(
    redactableItems(base).map((i) => [i.n, i.kind, i.text]),
    [
      [1, "fact", base.facts[0].claim],
      [2, "recommendation", "Reconnect the inbox."],
      [3, "recommendation", "Ask Dave in ops to check."],
      [4, "recommendation", "Then resume."],
      [5, "needsWrite", "Raise the plan limit."],
    ]
  );
  const redacted = removeItems(base, [3, 5]);
  assert.equal(redacted?.recommendation, "Reconnect the inbox. Then resume.");
  assert.equal(redacted?.needsWrite, undefined);
  assert.deepEqual(redacted?.facts, base.facts);
  assert.equal(redacted?.report, base.report);

  // Unusable numbers, an empty list, or nothing left to say all refuse, and the gate blocks.
  assert.equal(removeItems(base, []), null);
  assert.equal(removeItems(base, [0]), null);
  assert.equal(removeItems(base, [6]), null);
  assert.equal(removeItems(base, [1.5]), null);
  assert.equal(removeItems(base, [1, 2, 3, 4]), null);
});

test("the ownership query binds the verified scope and only validated literals", () => {
  const query = buildOwnershipQuery(scope, {
    emails: ["Someone@Example.com"],
    slugs: [scope.organizationSlug],
    uuids: [campaignId],
  });
  assert.match(query, new RegExp(`o\\.id = '${scope.organizationId}'::uuid`));
  assert.match(query, new RegExp(`m\\.user_id = '${scope.userId}'::uuid`));
  assert.match(query, EMAIL_LITERAL);
  assert.throws(() =>
    buildOwnershipQuery(scope, {
      emails: ["x'); drop table member; --@a.b"],
      slugs: [],
      uuids: [],
    })
  );
  assert.throws(() =>
    buildOwnershipQuery(scope, { emails: [], slugs: [], uuids: ["not-a-uuid"] })
  );
});
