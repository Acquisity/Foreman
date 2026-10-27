import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { ApprovalContext } from "eve/tools/approval";
import { gatherDisputeEvidencePolicy } from "../tools/gather_dispute_evidence.js";
import {
  evidenceQueries,
  fitResponse,
  gatherDisputeEvidence,
  sqlLiteral,
} from "./dispute-evidence.js";
import {
  AFTER,
  BA,
  BEFORE,
  CHARGE,
  facts,
  fake,
  gather,
  json,
  type Obj,
  ORG_A,
  ORG_B,
  TABLE,
  type World,
} from "./dispute-evidence-fixtures.js";
import { member, WORKSPACE_ID } from "./instantly-fixtures.js";
import { READ_BYTES } from "./stripe-dispute-read.js";
import { stripeDisputeSessionAuth } from "./stripe-dispute-trigger.js";
import { stampIntakeOnly } from "./trust.js";

const FROM_ORGANIZATION = /from organization/u;
const FROM_MAIL_DOMAIN = /from mail_domain /u;
const HTTP_422 = /422/u;
const MISSING_SCOPE = /missing_scope/u;
const TOKEN = /token/iu;
const LIMITED = /limit \d+$/u;
const DOMAINS_ERROR = /domains/u;
const ESCAPED_ORG = /organization_id = 'o''x'/u;

/** The first call of each source, in the order they ran. */
const sourceOrder = (calls: string[]) => [
  ...new Set(
    calls.map((call) => {
      if (call === "sql") {
        return "database";
      }
      return call.startsWith("slack.") ? "slack" : call.split(".")[0];
    })
  ),
];

describe("gatherDisputeEvidence sources", () => {
  it("reads every source in order and marks each checked", async () => {
    const { calls, result } = await gather();
    assert.deepEqual(sourceOrder(calls), [
      "stripe",
      "database",
      "autumn",
      "linear",
      "slack",
    ]);
    for (const source of Object.values(result.sources)) {
      assert.equal(source.checked, true);
    }
    assert.equal(facts(result, "instantly").workspace, null);
    const linear = facts(result, "linear");
    assert.equal(
      linear.tickets.rows[0]?.description,
      "Customer asks for a refund. owner@acme.io"
    );
    assert.equal(
      linear.tickets.rows[0]?.comments[0]?.body,
      "We will not refund."
    );
    const slack = facts(result, "slack");
    assert.deepEqual(slack.channel, { id: "G0ACME", name: "acme-io-client" });
    assert.deepEqual(
      slack.messages.rows.map((message) => [message.text, message.author]),
      [
        ["Domains are live", "Staff"],
        ["Thanks!", "Staff"],
      ]
    );
  });

  it("keeps reading after a source fails and reports it as unchecked", async () => {
    const { calls, result } = await gather({ failSql: FROM_ORGANIZATION });
    assert.deepEqual(sourceOrder(calls), [
      "stripe",
      "database",
      "autumn",
      "linear",
      "slack",
    ]);
    assert.equal(result.sources.database.checked, false);
    assert.match(
      result.sources.database.checked ? "" : result.sources.database.error,
      HTTP_422
    );
    assert.equal(result.sources.instantly.checked, false);
    for (const source of ["stripe", "autumn", "linear", "slack"] as const) {
      assert.equal(result.sources[source].checked, true, source);
    }
    assert.equal(result.verdict.usedAfterCharge.value, null);
  });

  it("names a failed table instead of treating it as empty", async () => {
    const { result } = await gather({ failSql: FROM_MAIL_DOMAIN });
    assert.ok(
      result.sources.database.facts?.unavailable.some((entry) =>
        entry.startsWith("domains:")
      )
    );
    assert.equal(result.verdict.deliveryStoppedBeforeCharge.value, null);
  });

  it("fails every dependent source when the Stripe read fails", async () => {
    const stub = fake();
    const { read } = stub.deps;
    const result = await gatherDisputeEvidence("du_1", {
      ...stub.deps,
      read: (request, options) =>
        request.operation === "stripe.disputes.get"
          ? json(null, 500)
          : read(request, options),
    });
    for (const source of Object.values(result.sources)) {
      assert.equal(source.checked, false);
    }
    assert.equal(result.verdict.refundedInFull.value, null);
  });
});

describe("verdictFacts", () => {
  it("refunded in full, or only partly", async () => {
    const refund = { amount: 25_200, created: CHARGE + 86_400, id: "re_1" };
    const full = await gather({
      charge: { amount_refunded: 25_200, refunds: { data: [refund] } },
    });
    assert.equal(full.result.verdict.refundedInFull.value, true);
    assert.equal(
      full.result.verdict.refundedInFull.because[0]?.date,
      "2026-10-05T00:00:00.000Z"
    );
    const partial = await gather({
      charge: {
        amount_refunded: 10_000,
        refunds: { data: [{ ...refund, amount: 10_000 }] },
      },
    });
    assert.equal(partial.result.verdict.refundedInFull.value, false);
  });

  it("delivery stopped before the charge, or only after it", async () => {
    const domain = (date: string) => ({
      tables: {
        mail_domain: [
          { domain: "acme.co", expires_at: date, status: "expired" },
        ],
      },
    });
    const stopped = await gather(domain(BEFORE));
    assert.equal(
      stopped.result.verdict.deliveryStoppedBeforeCharge.value,
      true
    );
    assert.equal(
      stopped.result.verdict.deliveryStoppedBeforeCharge.because[0]?.source,
      "database.mail_domain"
    );
    const later = await gather(domain(AFTER));
    assert.equal(later.result.verdict.deliveryStoppedBeforeCharge.value, false);
  });

  it("delivery stopped when the charge's subscription was canceled first", async () => {
    const { result } = await gather({
      invoices: [{ id: "in_1", subscription: "sub_1" }],
      subscriptions: [{ canceled_at: CHARGE - 86_400, id: "sub_1" }],
    });
    assert.equal(result.verdict.deliveryStoppedBeforeCharge.value, true);
  });

  it("a duplicate bills the same item for the same period, not the same amount", async () => {
    const line = (price: string) => ({
      lines: { data: [{ period: { end: 2, start: 1 }, price: { id: price } }] },
      subscription: price === "price_domains" ? "sub_domains" : "sub_inboxes",
    });
    const other = {
      amount: 25_200,
      amount_refunded: 0,
      created: CHARGE - 3600,
      id: "ch_2",
      invoice: "in_2",
      status: "succeeded",
    };
    const same = await gather({
      charges: [other],
      invoices: [
        { id: "in_1", ...line("price_domains") },
        { id: "in_2", ...line("price_domains") },
      ],
    });
    assert.equal(same.result.verdict.duplicate.value, true);
    const different = await gather({
      charges: [other],
      invoices: [
        { id: "in_1", ...line("price_domains") },
        { id: "in_2", ...line("price_inboxes") },
      ],
    });
    assert.equal(different.result.verdict.duplicate.value, false);
  });

  it("use after the charge counts only in the workspace the charge provisioned", async () => {
    const used = await gather({
      tables: {
        session: [
          { active_organization_id: ORG_A, created_at: AFTER, user_id: "u1" },
        ],
      },
    });
    assert.equal(used.result.verdict.tiedToWorkspace.value, true);
    assert.equal(used.result.verdict.usedAfterCharge.value, true);

    const other = await gather({
      charge: { metadata: { order_id: "order-1" } },
      tables: {
        [`session@${ORG_B}`]: [
          { activity_date: AFTER, activity_type: "login", user_id: "u2" },
        ],
        organization: [
          { billing_account_id: BA, id: ORG_A, name: "Acme" },
          { billing_account_id: BA, id: ORG_B, name: "Acme Two" },
        ],
      },
    });
    assert.equal(other.result.verdict.tiedToWorkspace.value, true);
    assert.equal(other.result.verdict.usedAfterCharge.value, false);
    assert.ok(
      other.queries
        .filter((query) => !TABLE.exec(query)?.[1]?.startsWith("organization"))
        .every((query) => !query.includes(ORG_B))
    );
  });

  it("is not tied to a workspace without a billing account workspace", async () => {
    const none = await gather({ tables: { organization: [] } });
    assert.equal(none.result.verdict.tiedToWorkspace.value, false);
    const ambiguous = await gather({
      tables: {
        domain_purchase_order: [],
        organization: [
          { billing_account_id: BA, id: ORG_A, name: "Acme" },
          { billing_account_id: BA, id: ORG_B, name: "Acme Two" },
        ],
      },
    });
    assert.equal(ambiguous.result.verdict.tiedToWorkspace.value, null);
  });
});

describe("database queries", () => {
  it("never puts an unvalidated billing account id into SQL", async () => {
    const { calls, result } = await gather({ autumnId: "x' or '1'='1" });
    assert.equal(calls.includes("sql"), false);
    assert.equal(result.sources.database.checked, false);
    assert.equal(result.verdict.tiedToWorkspace.value, null);
  });

  it("escapes literals, never selects the session token, and limits every query", async () => {
    assert.equal(sqlLiteral("o'x"), "'o''x'");
    const queries = evidenceQueries(BA, "o'x", "2026-10-04T00:00:00.000Z");
    for (const query of Object.values(queries)) {
      assert.doesNotMatch(query, TOKEN);
      assert.match(query, LIMITED);
      assert.ok(!query.includes("'o'x'"));
    }
    assert.match(queries.domains, ESCAPED_ORG);
    assert.match(queries.organizations, new RegExp(`'${BA}'`, "u"));

    const { queries: sent } = await gather();
    assert.ok(sent.length > 10);
    assert.ok(sent.every((query) => !TOKEN.test(query)));
  });

  it("flags a list cut by its row limit", async () => {
    const orders = Array.from({ length: 60 }, (_, index) => ({
      id: `order-${index}`,
      organization_id: ORG_A,
      paid_at: BEFORE,
    }));
    const { result } = await gather({
      tables: { domain_purchase_order: orders },
    });
    const database = facts(result, "database");
    assert.equal(database.orders?.rows.length, 50);
    assert.equal(database.orders?.truncated, true);
  });
});

describe("client channel", () => {
  it("reports Slack ok:false as a failed source", async () => {
    const { result } = await gather({ slackError: "missing_scope" });
    assert.equal(result.sources.slack.checked, false);
    assert.match(
      result.sources.slack.checked ? "" : result.sources.slack.error,
      MISSING_SCOPE
    );
  });

  it("matches by workspace name or company email domain", async () => {
    const byName = await gather({
      email: "owner@gmail.com",
      slackChannels: [{ id: "G0ACME", name: "client-acme" }],
    });
    assert.equal(facts(byName.result, "slack").channel?.id, "G0ACME");
    const byDomain = await gather({
      slackChannels: [{ id: "G0ACMEIO", name: "acme-io-team" }],
      tables: {
        organization: [{ billing_account_id: BA, id: ORG_A, name: "Zeta" }],
      },
    });
    assert.equal(facts(byDomain.result, "slack").channel?.id, "G0ACMEIO");
  });

  it("reads no channel when several clients match", async () => {
    const { calls, result } = await gather({
      slackChannels: [
        { id: "G0ONE", name: "acme-one" },
        { id: "G0TWO", name: "acme-two" },
      ],
    });
    assert.equal(result.sources.slack.checked, false);
    assert.equal(calls.includes("slack.aia.history"), false);
  });

  it("only ever calls the four Slack read operations", async () => {
    const { calls } = await gather();
    const slack = calls.filter((call) => call.startsWith("slack."));
    assert.ok(slack.length > 0);
    for (const call of slack) {
      assert.ok(
        [
          "slack.aia.channels",
          "slack.aia.history",
          "slack.aia.replies",
          "slack.aia.user",
        ].includes(call),
        call
      );
    }
  });
});

describe("bounds", () => {
  it("keeps the response under the read cap and flags what it cut", async () => {
    const slackMessages = Array.from({ length: 400 }, (_, index) => ({
      text: "x".repeat(5000),
      ts: `17598${String(index).padStart(5, "0")}.000100`,
      user: "U0CLIENT",
    }));
    const { result } = await gather({ slackMessages });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= READ_BYTES);
    const { messages } = facts(result, "slack");
    assert.equal(messages.truncated, true);
    assert.ok(messages.rows.length < 400);
    assert.ok(
      messages.rows.every((message) => (message.text?.length ?? 0) <= 1503)
    );
  });

  it("fitResponse returns an explicit bounded failure when the envelope cannot fit", async () => {
    const { result } = await gather();
    const fitted = fitResponse(result, 2000);
    assert.ok(fitted.error);
    assert.ok(
      Buffer.byteLength(
        JSON.stringify({ ok: false, reason: fitted.error, result: fitted })
      ) < READ_BYTES
    );
    assert.equal(fitted.verdict.usedAfterCharge.value, null);
  });
});

describe("gather_dispute_evidence access", () => {
  const approval = (auth: SessionAuthContext, parent = false) =>
    gatherDisputeEvidencePolicy({
      session: {
        auth: { current: auth, initiator: auth },
        ...(parent ? { parent: { sessionId: "p" } } : {}),
      },
      toolInput: { disputeId: "du_1" },
    } as unknown as ApprovalContext);
  const automatic = stripeDisputeSessionAuth({
    disputeId: "du_1",
    teamId: "T123",
    threadTs: "1761400000.000100",
  });

  it("allows the dispute session and denies intake-only and delegated sessions", () => {
    assert.equal(approval(automatic), "not-applicable");
    assert.equal(
      (approval(automatic, true) as { type: string }).type,
      "denied"
    );
    assert.equal(
      (approval(stampIntakeOnly(automatic)) as { type: string }).type,
      "denied"
    );
  });
});

// Review regressions: these cases exercise the provider boundaries, not just
// separately scoped fake table names.
describe("dispute review regressions", () => {
  it("finding 1: never chooses another workspace by order date", async () => {
    const { result } = await gather({
      tables: {
        domain_purchase_order: [
          {
            id: "unrelated",
            organization_id: ORG_B,
            paid_at: "2026-10-04 12:00:00+00",
          },
        ],
        organization: [
          { billing_account_id: BA, id: ORG_A, name: "Acme" },
          { billing_account_id: BA, id: ORG_B, name: "Other" },
        ],
      },
    });
    assert.equal(facts(result, "database").provisioned, null);
    assert.equal(result.verdict.tiedToWorkspace.value, null);
  });

  it("finding 2: global user activity cannot prove workspace use", async () => {
    const { result, queries } = await gather({
      tables: {
        member: [{ last_login: AFTER, user_id: "shared" }],
        user_activity: [{ activity_date: AFTER, user_id: "shared" }],
      },
    });
    assert.equal(result.verdict.usedAfterCharge.value, false);
    assert.ok(
      queries.some((query) =>
        query.includes(`active_organization_id = '${ORG_A}'`)
      )
    );
    assert.ok(queries.every((query) => !query.includes("from user_activity")));
  });

  it("finding 3: uses the whole email domain and whole workspace tokens", async () => {
    const { result, calls } = await gather({
      email: "owner@acme.io",
      slackChannels: [{ id: "G0OTHER", name: "client-acme-other" }],
      tables: {
        organization: [{ billing_account_id: BA, id: ORG_A, name: "Zeta" }],
      },
    });
    assert.equal(result.sources.slack.checked, false);
    assert.equal(calls.includes("slack.aia.history"), false);
  });

  it("finding 4: drops ticket bodies without exact customer ownership", async () => {
    const { result } = await gather({
      linearDescription:
        "A different customer's refund request. other@elsewhere.io",
    });
    assert.equal(facts(result, "linear").tickets.rows.length, 0);
    assert.equal(
      (facts(result, "linear") as { droppedCandidates?: number })
        .droppedCandidates,
      1
    );
  });

  it("finding 5: another subscription at the same price is not a duplicate", async () => {
    const line = (subscription: string, period = true) => ({
      lines: {
        data: [
          {
            price: { id: "price_shared" },
            ...(period ? { period: { end: 2, start: 1 } } : {}),
          },
        ],
      },
      subscription,
    });
    const charges = [
      {
        amount: 25_200,
        amount_refunded: 0,
        id: "ch_2",
        invoice: "in_2",
        status: "succeeded",
      },
    ];
    const different = await gather({
      charges,
      invoices: [
        { id: "in_1", ...line("sub_A") },
        { id: "in_2", ...line("sub_B") },
      ],
    });
    assert.equal(different.result.verdict.duplicate.value, false);
    const missing = await gather({
      charges,
      invoices: [
        { id: "in_1", ...line("sub_A", false) },
        { id: "in_2", ...line("sub_A", false) },
      ],
    });
    assert.equal(missing.result.verdict.duplicate.value, null);
  });

  it("finding 6: a truncated list cannot prove a negative verdict", async () => {
    const stub = fake({
      invoices: [
        {
          id: "in_1",
          lines: { data: [{ period: { end: 2, start: 1 } }] },
          subscription: "sub_A",
        },
      ],
    });
    const { read } = stub.deps;
    const result = await gatherDisputeEvidence("du_1", {
      ...stub.deps,
      read: (request, options) =>
        request.operation === "stripe.charges.list"
          ? json({ data: [], has_more: true })
          : read(request, options),
    });
    assert.equal(result.verdict.duplicate.value, null);
  });

  it("finding 7: a failed constituent marks the source failed with partial facts", async () => {
    const { result } = await gather({ failSql: FROM_MAIL_DOMAIN });
    assert.equal(result.sources.database.checked, false);
    assert.ok("facts" in result.sources.database);
    if (!result.sources.database.checked) {
      assert.match(result.sources.database.error, DOMAINS_ERROR);
    }
  });

  it("finding 8: oversized proof and scalar text never escape the output cap", async () => {
    const { result } = await gather({
      tables: {
        member: Array.from({ length: 50 }, () => ({
          email: "x".repeat(6000),
          last_login: AFTER,
        })),
      },
    });
    assert.ok(
      Buffer.byteLength(JSON.stringify({ ok: true, result })) < READ_BYTES
    );
  });

  it("finding 9: verdict logic is usable independently of provider adapters", async () => {
    const verdict = await import("./dispute-verdict.js");
    const { result } = await gather();
    assert.deepEqual(verdict.verdictFacts(result.sources), result.verdict);
  });

  it("finding 10: an unread replies page marks the conversation incomplete", async () => {
    const stub = fake();
    const { slack } = stub.deps;
    const result = await gatherDisputeEvidence("du_1", {
      ...stub.deps,
      slack: async (request, options) => {
        const response = await slack(request, options);
        return request.operation === "slack.aia.replies"
          ? {
              ...response,
              data: {
                ...(response.data as Obj),
                has_more: true,
                response_metadata: { next_cursor: "next" },
              },
            }
          : response;
      },
    });
    assert.equal(facts(result, "slack").messages.truncated, true);
  });
});

// Explicit-link and completeness edges supplement the ten review regressions.
describe("dispute attribution boundaries", () => {
  const organizations = [
    { billing_account_id: BA, id: ORG_A, name: "Acme" },
    { billing_account_id: BA, id: ORG_B, name: "Other" },
  ];

  it("uses charge, invoice, or invoice-line metadata and scopes known orders", async () => {
    for (const link of ["charge", "invoice", "line"] as const) {
      const stub = fake({
        charge: link === "charge" ? { metadata: { order_id: "order-1" } } : {},
        invoices: [
          {
            id: "in_1",
            lines: {
              data:
                link === "line" ? [{ metadata: { order_id: "order-1" } }] : [],
            },
            metadata:
              link === "invoice" ? { domain_purchase_order_id: "order-1" } : {},
          },
        ],
        tables: { organization: organizations },
      });
      // biome-ignore lint/performance/noAwaitInLoops: isolate the three metadata origins.
      const result = await gatherDisputeEvidence("du_1", stub.deps);
      assert.equal(facts(result, "database").provisioned?.orderId, "order-1");
      for (const table of [
        "mail_domain",
        "mail_inbox",
        "mail_domain_cancellation",
        "cmr_subscription_cancellation",
      ]) {
        const query = stub.queries.find((value) =>
          value.includes(`from ${table} `)
        );
        assert.ok(query?.includes("'order-1'"), `${link}: ${table}`);
      }
    }
  });

  it("rejects conflicting explicit links and ignores deleted fallback organizations", async () => {
    const conflicting = await gather({
      charge: { metadata: { order_id: "order-1", organization_id: ORG_B } },
      tables: { organization: organizations },
    });
    assert.equal(facts(conflicting.result, "database").provisioned, null);
    const live = await gather({
      tables: {
        organization: [
          organizations[0],
          { ...organizations[1], deleted_at: BEFORE },
        ],
      },
    });
    assert.equal(
      facts(live.result, "database").provisioned?.organizationId,
      ORG_A
    );
    const explicit = await gather({
      charge: { metadata: { organizationId: ORG_B } },
      tables: { organization: organizations },
    });
    assert.equal(
      facts(explicit.result, "database").provisioned?.organizationId,
      ORG_B
    );
  });

  it("does not resolve workspaces from truncated organization or order inventories", async () => {
    for (const table of ["organization", "domain_purchase_order"]) {
      const stub = fake({ charge: { metadata: { order_id: "order-1" } } });
      const { sql } = stub.deps;
      // biome-ignore lint/performance/noAwaitInLoops: each inventory fails independently.
      const result = await gatherDisputeEvidence("du_1", {
        ...stub.deps,
        sql: async (query) => {
          const raw = await sql(query);
          return query.includes(`from ${table} `)
            ? JSON.stringify({ rows: JSON.parse(raw), truncated: true })
            : raw;
        },
      });
      assert.equal(facts(result, "database").provisioned, null);
      assert.equal(result.verdict.tiedToWorkspace.value, null);
    }
  });

  it("preserves positive use despite truncation and treats negative use as unknown", async () => {
    const domains = Array.from({ length: 201 }, () => ({
      domain: "acme.io",
      provisioned_at: BEFORE,
    }));
    const noProof = await gather({ tables: { mail_domain: domains } });
    assert.equal(noProof.result.verdict.usedAfterCharge.value, null);
    const proof = await gather({
      tables: {
        mail_domain: [
          { domain: "new.acme.io", provisioned_at: AFTER },
          ...domains,
        ],
      },
    });
    assert.equal(proof.result.verdict.usedAfterCharge.value, true);
  });

  it("retains verified refund facts when another Stripe read fails", async () => {
    const stub = fake({ charge: { amount_refunded: 25_200 } });
    const { read } = stub.deps;
    const result = await gatherDisputeEvidence("du_1", {
      ...stub.deps,
      read: (request, options) =>
        request.operation === "stripe.credit_notes.list"
          ? json(null, 500)
          : read(request, options),
    });
    assert.equal(result.sources.stripe.checked, false);
    assert.ok(result.sources.stripe.facts?.charge);
    assert.equal(result.verdict.refundedInFull.value, true);
    assert.equal(result.sources.database.checked, true);
  });

  it("fails closed on incomplete or conflicting Slack identities and free mail", async () => {
    const cases: World[] = [
      {
        slackChannels: [
          { id: "G0NAME", name: "acme-client" },
          { id: "G0DOMAIN", name: "acme-io-client" },
        ],
      },
      {
        email: "owner@gmail.com",
        slackChannels: [{ id: "G0MAIL", name: "gmail-com-client" }],
        tables: {
          organization: [{ billing_account_id: BA, id: ORG_A, name: "Zeta" }],
        },
      },
      {
        email: "owner@gmail.com",
        slackChannels: [{ id: "G0PART", name: "acmeology-client" }],
      },
    ];
    for (const world of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: isolate unsafe identity combinations.
      const { result, calls } = await gather(world);
      assert.equal(result.sources.slack.checked, false);
      assert.equal(calls.includes("slack.aia.history"), false);
    }
    const stub = fake();
    const { slack } = stub.deps;
    const result = await gatherDisputeEvidence("du_1", {
      ...stub.deps,
      slack: async (request, options) => {
        const response = await slack(request, options);
        return request.operation === "slack.aia.channels"
          ? {
              ...response,
              data: {
                ...(response.data as Obj),
                response_metadata: { next_cursor: "more" },
              },
            }
          : response;
      },
    });
    assert.equal(result.sources.slack.checked, false);
    assert.equal(stub.calls.includes("slack.aia.history"), false);
  });

  it("exact Linear ownership rejects email substrings and marks limited text", async () => {
    const wrong = await gather({
      linearDescription: "Another customer: owner@acme.io.evil",
    });
    assert.equal(facts(wrong.result, "linear").tickets.rows.length, 0);
    const exact = await gather({
      linearDescription: `Workspace ${ORG_A}. ${"text ".repeat(1000)}`,
    });
    assert.equal(facts(exact.result, "linear").tickets.rows.length, 1);
    assert.equal(facts(exact.result, "linear").tickets.truncated, true);
  });
});

describe("dispute source completion", () => {
  it("runs positive Instantly reads between Autumn and Linear and retains partial failures", async () => {
    for (const fail of [false, true]) {
      const stub = fake({
        tables: {
          outreach_provider: [
            { provider: "instantly", workspace_id: WORKSPACE_ID },
          ],
        },
      });
      const { read } = stub.deps;
      // biome-ignore lint/performance/noAwaitInLoops: isolate success and constituent failure.
      const result = await gatherDisputeEvidence("du_1", {
        ...stub.deps,
        read: (request, options) => {
          if (!request.operation.startsWith("instantly.")) {
            return read(request, options);
          }
          stub.calls.push(request.operation);
          if (request.operation === "instantly.workspace-group-members") {
            return json({ items: [member()] });
          }
          if (request.operation === "instantly.accounts" && fail) {
            return json(null, 403);
          }
          return json({ items: [] });
        },
      });
      assert.deepEqual(sourceOrder(stub.calls), [
        "stripe",
        "database",
        "autumn",
        "instantly",
        "linear",
        "slack",
      ]);
      assert.equal(result.sources.instantly.checked, !fail);
      assert.ok(result.sources.instantly.facts?.campaigns);
    }
  });
});
