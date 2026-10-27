import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { ApprovalContext } from "eve/tools/approval";
import { gatherDisputeEvidencePolicy } from "../tools/gather_dispute_evidence.js";
import {
  type DisputeEvidence,
  type EvidenceDeps,
  evidenceQueries,
  fitResponse,
  gatherDisputeEvidence,
  type RowList,
  sqlLiteral,
} from "./dispute-evidence.js";
import type { ProviderResult } from "./executor/operations.js";
import { READ_BYTES } from "./stripe-dispute-read.js";
import { stripeDisputeSessionAuth } from "./stripe-dispute-trigger.js";
import { stampIntakeOnly } from "./trust.js";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const CHARGE = Date.parse("2026-10-04T00:00:00Z") / 1000;
const BA = "0b6c6f4e-3c1a-4d8e-9a77-2f1e5d4c3b2a";
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const AFTER = "2026-10-10 09:00:00+00";
const BEFORE = "2026-09-20 09:00:00+00";

type Obj = Record<string, unknown>;

interface World {
  autumnId?: string;
  charge?: Obj;
  charges?: Obj[];
  email?: string;
  failSql?: RegExp;
  invoices?: Obj[];
  slackChannels?: Obj[];
  slackError?: string;
  slackMessages?: Obj[];
  subscriptions?: Obj[];
  /** Rows by table, or by `table@organization` for one workspace. */
  tables?: Record<string, Obj[]>;
}

const json = (data: unknown, status = 200): Promise<ProviderResult> =>
  Promise.resolve({ data, status });

const TABLE = /\bfrom ("user"|[a-z_]+)/u;
const ORG = /organization_id = '([^']+)'/u;
const FROM_ORGANIZATION = /from organization/u;
const FROM_MAIL_DOMAIN = /from mail_domain /u;
const HTTP_422 = /422/u;
const MISSING_SCOPE = /missing_scope/u;
const TOKEN = /token/iu;
const LIMITED = /limit \d+$/u;
const ESCAPED_ORG = /organization_id = 'o''x'/u;

/** A fake of every provider; `calls` records each read in order. */
const fake = (world: World = {}) => {
  const calls: string[] = [];
  const queries: string[] = [];
  const tables: Record<string, Obj[]> = {
    domain_purchase_order: [
      {
        created_at: "2026-09-01 00:00:00+00",
        id: "order-1",
        organization_id: ORG_A,
        paid_at: "2026-09-01 00:00:00+00",
      },
    ],
    organization: [{ billing_account_id: BA, id: ORG_A, name: "Acme" }],
    ...world.tables,
  };
  const deps: EvidenceDeps = {
    linear: (request) => {
      calls.push(request.operation);
      if (request.operation === "linear.RelatedIssues") {
        return json({
          data: {
            issues: {
              nodes: [
                {
                  assignee: null,
                  createdAt: "2026-10-12T00:00:00Z",
                  id: "i1",
                  identifier: "CSP-12",
                  labels: { nodes: [] },
                  parent: null,
                  state: { name: "Done", type: "completed" },
                  title: "Refund request",
                  url: "https://linear.app/x/CSP-12",
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        });
      }
      return json({
        data: {
          issues: {
            nodes: [
              {
                comments: {
                  nodes: [
                    {
                      body: "We will not refund.",
                      createdAt: "2026-10-13T00:00:00Z",
                      user: { name: "Support" },
                    },
                  ],
                },
                createdAt: "2026-10-12T00:00:00Z",
                description: "Customer asks for a refund.",
                identifier: "CSP-12",
                state: { name: "Done" },
                title: "Refund request",
                url: "https://linear.app/x/CSP-12",
              },
            ],
          },
        },
      });
    },
    now: () => NOW,
    read: (request) => {
      calls.push(request.operation);
      switch (request.operation) {
        case "stripe.disputes.get":
          return json({
            amount: 25_200,
            charge: "ch_1",
            evidence_details: { due_by: NOW / 1000 + 86_400 },
            id: "du_1",
            reason: "fraudulent",
            status: "needs_response",
          });
        case "stripe.charges.get":
          return json({
            amount: 25_200,
            amount_refunded: 0,
            billing_details: { email: "card@example.com", name: "Abdul" },
            created: CHARGE,
            customer: "cus_1",
            id: "ch_1",
            invoice: "in_1",
            refunds: { data: [] },
            ...world.charge,
          });
        case "stripe.customers.get":
          return json({
            email: world.email ?? "owner@acme.io",
            metadata: { autumn_id: world.autumnId ?? BA },
            name: "Owner",
          });
        case "stripe.invoices.list":
          return json({ data: world.invoices ?? [], has_more: false });
        case "stripe.subscriptions.list":
          return json({ data: world.subscriptions ?? [], has_more: false });
        case "stripe.charges.list":
          return json({ data: world.charges ?? [], has_more: false });
        case "stripe.credit_notes.list":
          return json({ data: [], has_more: false });
        case "autumn.customer":
          return json({ id: BA, purchases: [], subscriptions: [] });
        default:
          return Promise.reject(new Error(`unexpected ${request.operation}`));
      }
    },
    slack: (request) => {
      calls.push(request.operation);
      if (world.slackError) {
        return json({ error: world.slackError, ok: false });
      }
      switch (request.operation) {
        case "slack.aia.channels":
          return json({
            channels: world.slackChannels ?? [
              { id: "G0ACME", name: "acme-client" },
              { id: "G0BETA", name: "beta-co" },
            ],
            ok: true,
            response_metadata: { next_cursor: "" },
          });
        case "slack.aia.history":
          return json({
            messages: world.slackMessages ?? [
              {
                reply_count: 1,
                text: "Domains are live",
                ts: "1759800000.000100",
                user: "U0STAFF",
              },
            ],
            ok: true,
          });
        case "slack.aia.replies":
          return json({
            messages: [
              { text: "Domains are live", ts: "1759800000.000100" },
              { text: "Thanks!", ts: "1759800100.000100", user: "U0CLIENT" },
            ],
            ok: true,
          });
        default:
          return json({ ok: true, user: { real_name: "Staff" } });
      }
    },
    sql: (query) => {
      calls.push("sql");
      queries.push(query);
      if (world.failSql?.test(query)) {
        return Promise.reject(new Error("PlanetScale answered HTTP 422."));
      }
      const table = TABLE.exec(query)?.[1] ?? "";
      const org = ORG.exec(query)?.[1];
      const rows = (org && tables[`${table}@${org}`]) || tables[table] || [];
      return Promise.resolve(JSON.stringify(rows));
    },
  };
  return { calls, deps, queries };
};

const gather = (world?: World) => {
  const stub = fake(world);
  return gatherDisputeEvidence("du_1", stub.deps).then((result) => ({
    ...stub,
    result,
  }));
};

const facts = <K extends keyof DisputeEvidence["sources"]>(
  result: DisputeEvidence,
  source: K
) => {
  const read = result.sources[source];
  assert.ok(read.checked, `${source} failed: ${!read.checked && read.error}`);
  return read.facts as Extract<
    DisputeEvidence["sources"][K],
    { checked: true }
  >["facts"];
};

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
      "Customer asks for a refund."
    );
    assert.equal(
      linear.tickets.rows[0]?.comments[0]?.body,
      "We will not refund."
    );
    const slack = facts(result, "slack");
    assert.deepEqual(slack.channel, { id: "G0ACME", name: "acme-client" });
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
      facts(result, "database").unavailable.some((entry) =>
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
        user_activity: [
          { activity_date: AFTER, activity_type: "login", user_id: "u1" },
        ],
      },
    });
    assert.equal(used.result.verdict.tiedToWorkspace.value, true);
    assert.equal(used.result.verdict.usedAfterCharge.value, true);

    const other = await gather({
      tables: {
        [`user_activity@${ORG_B}`]: [
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
    assert.equal(result.verdict.tiedToWorkspace.value, false);
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

  it("fitResponse halves the largest list until it fits", () => {
    const big: { a: RowList; b: RowList } = {
      a: {
        rows: Array.from({ length: 100 }, () => ({ v: "y".repeat(100) })),
        truncated: false,
      },
      b: { rows: [{ v: 1 }], truncated: false },
    };
    const fitted = fitResponse(big, 2000);
    assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 2000);
    assert.equal(fitted.a.truncated, true);
    assert.equal(fitted.b.truncated, false);
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
