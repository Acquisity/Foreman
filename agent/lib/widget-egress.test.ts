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
  withoutTicketRefs,
} from "./widget-egress.js";
import { buildOwnershipQuery } from "./widget-evidence.js";
import type { WidgetFindings } from "./widget-findings.js";

const RECONNECT = /Reconnect/;
const INTERNAL = /^internal_artifact:/;
const COMPOSED_FOREIGN = /^composed:foreign_identifier:/;
const COMPOSED_INTERNAL = /^composed:internal_artifact:/;
const STRIPE_CUSTOMER_ID = /cus_/;
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
        domains: new Set<string>(),
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
    { domains: [], emails: [], slugs: [], uuids: [campaignId] },
  ]);
  const [composed] = calls.compose as { findings: unknown }[];
  assert.deepEqual(composed.findings, composerInput(findings()));
  assert.equal(JSON.stringify(composed).includes("planetscale"), false);
  assert.equal(JSON.stringify(composed).includes("row-1"), false);
});

test("an item carrying a foreign identifier is deleted and the rest is answered; it never reaches a model", async () => {
  for (const foreign of [foreignId, "accounts.google.com"]) {
    const { calls, deps: d } = deps();
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own gate run.
    const result = await gate(
      scope,
      question,
      findings({
        recommendation: `Reconnect the inbox. Another customer ${foreign} fixed this the same way.`,
      }),
      d
    );
    assert.equal(result.decision, "allow");
    assert.equal(result.findings.recommendation, "Reconnect the inbox.");
    assert.equal(
      JSON.stringify([calls.judge, calls.compose]).includes(foreign),
      false
    );
  }
});

test("a foreign identifier in every item, or in an entity id, still blocks before any model call", async () => {
  for (const overrides of [
    {
      facts: [],
      recommendation: `Another customer ${foreignId} fixed this by reconnecting.`,
    },
    {
      facts: [{ ...findings().facts[0], entityIds: [foreignId] }],
    },
  ]) {
    const { calls, deps: d } = deps();
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own gate run.
    const result = await gate(scope, question, findings(overrides), d);
    assert.equal(result.decision, "block");
    assert.equal(result.reason, `foreign_identifier:${foreignId}`);
    assert.equal(result.message, null);
    assert.equal(calls.judge.length, 0);
    assert.equal(calls.compose.length, 0);
  }
});

for (const [label, text] of [
  [
    "a Sentry link",
    "See https://acquisity.sentry.io/issues/12345 for the trace.",
  ],
  ["an Inngest run id", "Run 01J8ZQ3K4M5N6P7Q8R9S0T1V2W failed twice."],
  ["a stack trace", "It threw:\n    at sendCampaign (campaign.ts:12:5)"],
  ["a bare internal host", "The failure is visible on sentry.io."],
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

test("the customer's own lead, inbox and sending domain pass; ones the workspace does not own block", async () => {
  const mine = {
    domains: new Set(["outreach-diamond.com"]),
    emails: new Set(["sarah@cyberdyne.com", "hello@outreach-diamond.com"]),
    slugs: new Set<string>(),
    uuids: new Set([campaignId]),
  };
  const owned = deps({ resolve: () => Promise.resolve(mine) });
  const allowed = await gate(
    scope,
    question,
    findings({
      recommendation:
        "Your lead sarah@cyberdyne.com replied, but hello@outreach-diamond.com is disconnected and outreach-diamond.com is unverified.",
    }),
    owned.deps
  );
  assert.equal(allowed.decision, "allow");

  for (const [text, foreign] of [
    ["The lead john@elsewhere.com bounced.", "john@elsewhere.com"],
    [
      "Your inbox at mail.example-sender.com bounced.",
      "mail.example-sender.com",
    ],
  ] as const) {
    const { calls, deps: d } = deps({ resolve: () => Promise.resolve(mine) });
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own gate run.
    const result = await gate(
      scope,
      question,
      // Nothing else to say, so deleting the item leaves no reply: it blocks.
      findings({ facts: [], recommendation: text }),
      d
    );
    assert.equal(result.reason, `foreign_identifier:${foreign}`);
    assert.equal(result.message, null);
    assert.equal(calls.judge.length, 0);
  }
});

test("an item citing another ticket is dropped whole; the conversation's own ticket stays", () => {
  const cleaned = withoutTicketRefs(
    findings({
      recommendation:
        "Click Launch. If it stays in Draft, it is a known issue (ENG-14065). See ENG-1.",
      ticket: { id: "ENG-1", url: "https://linear.app/acquisity/issue/ENG-1" },
    })
  );
  assert.equal(cleaned?.recommendation, "Click Launch. See ENG-1.");
});

test("the gate drops the sentence citing another ticket and answers with the rest", async () => {
  const { calls, deps: d } = deps();
  const result = await gate(
    scope,
    question,
    findings({
      recommendation: "Set a daily limit. Tracked in ENG-13999 and ENG-12140.",
    }),
    d
  );
  assert.notEqual(result.decision, "block");
  assert.ok(!JSON.stringify(calls.compose).includes("ENG-"));
});

test("a ticket number held only in a fact's identifiers does not block the answer", async () => {
  // Measured: a filed-ticket reply blocked as internal_artifact:ENG-14065 with the
  // number nowhere in a claim, only in the extractor's entityIds.
  const base = findings();
  const { deps: d } = deps();
  const result = await gate(
    scope,
    question,
    {
      ...base,
      facts: base.facts.map((fact) => ({
        ...fact,
        entityIds: [...fact.entityIds, "ENG-14065"],
      })),
    },
    d
  );
  assert.notEqual(result.decision, "block");
});

test("findings that are nothing but another ticket still block", async () => {
  const { deps: d } = deps();
  const result = await gate(
    scope,
    question,
    findings({ facts: [], recommendation: "Tracked in ENG-13999." }),
    d
  );
  assert.equal(result.decision, "block");
  assert.match(result.reason, INTERNAL);
});

test("the composer learns a ticket was filed, never which one", () => {
  const ticket = {
    id: "ENG-1",
    url: "https://linear.app/acquisity/issue/ENG-1",
  };
  const composed = composerInput(findings({ ticket }));
  assert.equal(composed.ticketFiled, true);
  assert.ok(!JSON.stringify(composed).includes("ENG-1"));
  assert.equal("ticketFiled" in composerInput(findings()), false);
});

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

test("a reviewed handoff with useful findings skips the composer and keeps them; a normal answer still composes", async () => {
  const { calls, deps: d } = deps();
  const raw = findings({ needsHuman: true });
  const result = await gate(scope, question, raw, d);
  assert.deepEqual(
    [result.decision, result.reason, result.message],
    ["block", "needs_human", null]
  );
  assert.deepEqual(result.findings, raw);
  // The safety review still ran; only the discarded reply was skipped.
  assert.equal(calls.judge.length, 1);
  assert.equal(calls.compose.length, 0);
  const answered = await gate(scope, question, findings(), d);
  assert.equal(answered.decision, "allow");
  assert.match(answered.message ?? "", RECONNECT);
  assert.equal(calls.compose.length, 1);
});

test("a handoff the reviewer blocks keeps the reviewer's reason", async () => {
  const { calls, deps: d } = deps({
    judge: () => Promise.resolve({ decision: "block", reason: "foreign data" }),
  });
  const result = await gate(scope, question, findings({ needsHuman: true }), d);
  assert.equal(result.reason, "model_gate:foreign data");
  assert.equal(calls.compose.length, 0);
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
  assert.match(result.reason, COMPOSED_FOREIGN);
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
  assert.match(result.reason, COMPOSED_INTERNAL);
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
  assert.throws(() =>
    buildOwnershipQuery(scope, {
      domains: ["a.com'); drop table member; --"],
      emails: [],
      slugs: [],
      uuids: [],
    })
  );
});

test("every table the ownership query reads is reached only through the verified workspace", () => {
  const query = buildOwnershipQuery(scope, {
    domains: ["outreach-diamond.com"],
    emails: ["sarah@cyberdyne.com"],
    slugs: [],
    uuids: [campaignId],
  });
  // A table read without the join would resolve another tenant's identifiers.
  for (const table of [
    "outreach_campaign c",
    "crm_message_thread t",
    "crm_contact ct",
    "crm_lead l",
    "mail_inbox i",
    "mail_domain d",
    "lead_scrape_run sr",
    "agent_executions ae",
    "domain_purchase_order dpo",
    "website w",
    "website_project wp",
    "website_domain wdm",
  ]) {
    const [, alias] = table.split(" ");
    assert.ok(
      query.includes(
        `${table} join authorized a on a.id = ${alias}.organization_id`
      ) ||
        query.includes(`join authorized a on a.id = ${alias}.organization_id`),
      `${table} must join authorized`
    );
  }
  // crm_email has no organization column: it is only reachable via a scoped parent.
  assert.equal(query.split("from crm_email ce").length - 1, 2);
  assert.ok(
    query.includes(
      "join crm_contact ct on ct.id = ce.contact_id join authorized"
    )
  );
  assert.ok(
    query.includes("join crm_lead l on l.id = ce.lead_id join authorized")
  );
});

test("a provider id in entityIds never reaches the customer, so it does not block the answer", async () => {
  const { calls, deps: d } = deps();
  const result = await gate(
    scope,
    "What plan am I on?",
    findings({
      facts: [
        {
          claim: "The workspace is on the Legacy plan.",
          entityIds: ["cus_AbCdEfGh12345678"],
          evidence: { ref: "", tool: "read_billing_account" },
        },
      ],
    }),
    d
  );
  assert.equal(result.decision, "allow");
  assert.doesNotMatch(JSON.stringify(calls.compose), STRIPE_CUSTOMER_ID);
});

test("the same provider id inside a claim still blocks", async () => {
  const { deps: d } = deps();
  const result = await gate(
    scope,
    "What plan am I on?",
    findings({
      facts: [
        {
          claim: "Customer cus_AbCdEfGh12345678 is on the Legacy plan.",
          entityIds: [],
          evidence: { ref: "", tool: "read_billing_account" },
        },
      ],
    }),
    d
  );
  assert.equal(result.decision, "block");
  assert.match(result.reason, INTERNAL);
});

test("a website's custom domain and the workspace's billing account are owned; the same shapes elsewhere stay foreign", async () => {
  const query = buildOwnershipQuery(scope, {
    domains: ["shop.customer-site.com"],
    emails: [],
    slugs: [],
    uuids: [campaignId],
  });
  // The billing account is reached only through the authorized organization row.
  assert.ok(
    query.includes(
      "select o.billing_account_id from organization o join authorized a on a.id = o.id"
    )
  );
  assert.ok(
    query.includes("lower(w.custom_domain) from website w join authorized")
  );
  assert.ok(
    query.includes("lower(wdm.domain) from website_domain wdm join authorized")
  );

  const ownedDomain = "shop.customer-site.com";
  const answer = (domain: string) =>
    gate(
      scope,
      "Why does my site 404?",
      findings({
        facts: [{ ...findings().facts[0], entityIds: [campaignId, domain] }],
      }),
      deps({
        resolve: () =>
          Promise.resolve({
            domains: new Set([ownedDomain]),
            emails: new Set<string>(),
            slugs: new Set<string>(),
            uuids: new Set([campaignId]),
          }),
      }).deps
    );
  assert.equal((await answer(ownedDomain)).decision, "allow");
  const foreign = await answer("other-tenant-site.com");
  assert.equal(foreign.decision, "block");
  assert.equal(foreign.reason, "foreign_identifier:other-tenant-site.com");
});

test("a source file named in a website fix is not a domain; a real unowned domain beside it still blocks", async () => {
  const fix = (text: string) =>
    gate(
      scope,
      "Why won't my site publish?",
      findings({ recommendation: text }),
      deps().deps
    );
  const allowed = await fix(
    'Paste this into the builder chat: "Fix the type error in components/ui/calendar.tsx and next.config.js without changing the design."'
  );
  assert.equal(allowed.decision, "allow");
  assert.equal(
    extractIdentifiers(
      findings({
        recommendation: "See calendar.tsx and other-tenant-site.com.",
      })
    ).candidates.domains?.join(),
    "other-tenant-site.com"
  );
});

test("a billing review keeps its verified facts and open questions for the teammate, and repurchase advice never reaches the composer", async () => {
  const raw = findings({
    needsHuman: true,
    recommendation:
      "Place a fresh domain order to get the domain back. Billing needs to confirm whether the March charge was for this order.",
  });
  const { calls, deps: d } = deps({
    judge: (input) =>
      Promise.resolve({
        decision: "rewrite",
        reason: "repurchase advice while the original order is unresolved",
        remove: input.items
          .filter((item) => item.text.startsWith("Place a fresh"))
          .map((item) => item.n),
      }),
  });
  const result = await gate(scope, question, raw, d);
  assert.equal(result.reason, "needs_human");
  assert.deepEqual(result.findings, raw);
  assert.equal(calls.compose.length, 0);
  assert.equal(JSON.stringify(calls.compose).includes("fresh domain"), false);
});
