import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  AFTER,
  BEFORE,
  CHARGE,
  facts,
  fake,
  gather,
  ORG_A,
} from "./__tests__/dispute-evidence-fixtures.js";
import {
  combinedEvidenceQuery,
  evidenceQueries,
  gatherDisputeEvidence,
  SOURCE_DEADLINES_MS,
} from "./dispute-evidence.js";
import { operationInputs } from "./executor/operations.js";
import { ExecutorError } from "./executor/transport.js";
import { WORKSPACE_ID } from "./instantly-fixtures.js";
import { PRODUCTION_READ_QUERY_ARGS } from "./lookup-customer.js";

const SOURCE_ORDER = [
  "stripe",
  "database",
  "autumn",
  "instantly",
  "linear",
  "slack",
];
const AGGREGATE = /json_agg\(evidence_rows\)/gu;
const DEADLINE = /deadline/iu;
const WORKSPACE_FAILURE = /workspace tables/u;

describe("dispute source performance", () => {
  it("a slow source aborts only itself while every other source completes", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const stub = fake();
    let started: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = gatherDisputeEvidence("du_1", {
      ...stub.deps,
      slack: (_request, options) =>
        new Promise((_resolve, reject) => {
          assert.ok(options?.signal);
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true }
          );
          started();
        }),
    });
    await ready;
    await nextTurn();
    t.mock.timers.tick(SOURCE_DEADLINES_MS.slack);
    const result = await pending;
    for (const [name, source] of Object.entries(result.sources)) {
      assert.equal(source.checked, name !== "slack", name);
    }
    assert.ok(!result.sources.slack.checked);
    assert.match(result.sources.slack.error, DEADLINE);
  });

  it("keeps fixed output order when a slow Autumn finishes after Slack", async () => {
    const stub = fake();
    const { read, slack } = stub.deps;
    let finishAutumn: () => void = () => undefined;
    const autumn = new Promise<void>((resolve) => {
      finishAutumn = resolve;
    });
    let slackDone: () => void = () => undefined;
    const slackReady = new Promise<void>((resolve) => {
      slackDone = resolve;
    });
    const completed: string[] = [];
    const pending = gatherDisputeEvidence("du_1", {
      ...stub.deps,
      read: async (request, options) => {
        if (request.operation === "autumn.customer") {
          await autumn;
          completed.push("autumn");
        }
        return read(request, options);
      },
      slack: async (request, options) => {
        const response = await slack(request, options);
        if (
          request.operation === "slack.aia.user" &&
          request.input.user === "U0CLIENT"
        ) {
          completed.push("slack");
          slackDone();
        }
        return response;
      },
    });
    await slackReady;
    await nextTurn();
    finishAutumn();
    const result = await pending;
    assert.deepEqual(completed, ["slack", "autumn"]);
    assert.deepEqual(Object.keys(result.sources), SOURCE_ORDER);
    assert.ok(Object.values(result.sources).every((source) => source.checked));
  });

  it("reads all table arrays in two sequential SQL calls without a statement size restriction", async () => {
    const stub = fake();
    const { sql } = stub.deps;
    let active = 0;
    const result = await gatherDisputeEvidence("du_1", {
      ...stub.deps,
      sql: async (query, signal) => {
        active += 1;
        assert.equal(active, 1);
        assert.ok(signal);
        await nextTurn();
        const response = await sql(query);
        active -= 1;
        return response;
      },
    });
    assert.equal(result.sources.database.checked, true);
    assert.equal(stub.queries.length, 2);
    assert.equal([...stub.queries[0].matchAll(AGGREGATE)].length, 2);
    assert.equal([...stub.queries[1].matchAll(AGGREGATE)].length, 15);
    for (const query of stub.queries) {
      assert.ok(query.length < 16 * 1024);
      assert.equal(
        operationInputs["planetscale.readQuery"].parse({
          ...PRODUCTION_READ_QUERY_ARGS,
          query,
        }).query,
        query
      );
    }
    assert.ok(
      combinedEvidenceQuery(
        evidenceQueries("validated-id", "o'x", "2026-10-04T00:00:00Z")
      ).includes("'o''x'")
    );
  });

  it("retries a combined SQL read once on 5xx or network failure", async () => {
    for (const failure of [
      new ExecutorError("planetscale_read_failed", 500),
      new TypeError("fetch failed"),
    ]) {
      const stub = fake();
      const { sql } = stub.deps;
      let calls = 0;
      // biome-ignore lint/performance/noAwaitInLoops: isolate each transient error class.
      const result = await gatherDisputeEvidence("du_1", {
        ...stub.deps,
        sql: (query) => {
          calls += 1;
          return calls === 1 ? Promise.reject(failure) : sql(query);
        },
      });
      assert.equal(result.sources.database.checked, true);
      assert.equal(calls, 3);
    }
  });

  it("a persistent combined SQL failure preserves account facts and names workspace tables", async () => {
    const stub = fake();
    const { sql } = stub.deps;
    let failures = 0;
    const result = await gatherDisputeEvidence("du_1", {
      ...stub.deps,
      sql: (query) => {
        if (query.includes('as "domains"')) {
          failures += 1;
          return Promise.reject(
            new ExecutorError("planetscale_read_failed", 503)
          );
        }
        return sql(query);
      },
    });
    assert.equal(failures, 2);
    assert.ok(!result.sources.database.checked);
    assert.match(result.sources.database.error, WORKSPACE_FAILURE);
    assert.ok(result.sources.database.facts?.organizations.rows.length);
  });

  it("a malformed table array fails that constituent rather than treating it as empty", async () => {
    const stub = fake();
    const { sql } = stub.deps;
    const result = await gatherDisputeEvidence("du_1", {
      ...stub.deps,
      sql: async (query) => {
        const rows = JSON.parse(await sql(query));
        if (query.includes('as "domains"')) {
          rows[0].domains = "cut-off json";
        }
        return JSON.stringify(rows);
      },
    });
    assert.equal(result.sources.database.checked, false);
    assert.equal(result.sources.database.facts?.domains, null);
    assert.equal(result.verdict.deliveryStoppedBeforeCharge.value, null);
  });
});

describe("live dispute shape regressions", () => {
  it("matches a paid invoice by amount and a unique payment time within 120 seconds", async () => {
    const invoice = (at: number) => ({
      amount_paid: 25_200,
      id: "in_new",
      lines: {
        data: [
          {
            parent: {
              subscription_item_details: {
                subscription: "sub_new",
                subscription_item: "si_new",
              },
            },
            period: { end: 2, start: 1 },
          },
        ],
      },
      status: "paid",
      status_transitions: { paid_at: at },
    });
    const input = {
      charge: { invoice: null, payment_intent: null },
      invoices: [invoice(CHARGE + 7)],
      subscriptions: [{ canceled_at: CHARGE - 1, id: "sub_new" }],
    };
    const matched = await gather(input);
    assert.equal(
      facts(matched.result, "stripe").chargeInvoice.invoice?.id,
      "in_new"
    );
    assert.equal(
      matched.result.verdict.deliveryStoppedBeforeCharge.value,
      true
    );
    for (const invoices of [
      [invoice(CHARGE + 121)],
      [invoice(CHARGE + 1), { ...invoice(CHARGE + 7), id: "in_other" }],
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: isolate missing and ambiguous invoice matches.
      const unresolved = await gather({ ...input, invoices });
      assert.equal(
        facts(unresolved.result, "stripe").chargeInvoice.invoice,
        null
      );
      assert.ok(facts(unresolved.result, "stripe").chargeInvoice.reason);
      assert.equal(
        unresolved.result.verdict.deliveryStoppedBeforeCharge.value,
        null
      );
    }
  });

  it("one of 23 failing inboxes is a partial outage, not stopped delivery", async () => {
    const { result } = await gather({
      tables: {
        mail_inbox: [
          {
            email: "failed@example.test",
            last_retry_at: BEFORE,
            status: "error",
          },
          ...Array.from({ length: 22 }, () => ({
            created_at: BEFORE,
            status: "active",
          })),
        ],
        outreach_campaign_metrics: [
          { date: AFTER.slice(0, 10), emails_sent: 14_717 },
        ],
      },
    });
    assert.equal(result.verdict.deliveryStoppedBeforeCharge.value, false);
    assert.equal(result.verdict.partialOutageBeforeCharge.value, true);
    assert.equal(result.verdict.usedAfterCharge.value, true);
    const partial = result.verdict.partialOutageBeforeCharge;
    assert.ok("counts" in partial);
    assert.deepEqual(partial.counts, {
      domains: { affected: 0, total: 0, truncated: false },
      inboxes: { affected: 1, total: 23, truncated: false },
    });
    const all = await gather({
      tables: { mail_inbox: [{ last_retry_at: BEFORE, status: "error" }] },
    });
    assert.equal(all.result.verdict.deliveryStoppedBeforeCharge.value, true);
  });

  it("matches anonymized full-name channels including stripped workspace suffixes", async () => {
    const cases = [
      {
        cardholder: "",
        channel: "client-nina-kapoor",
        customer: "Nina Kapoor",
        workspace: "Northwind",
      },
      {
        cardholder: "Samir Ali Khan",
        channel: "samir-ali-khan",
        customer: "Northwind",
        workspace: "Northwind",
      },
      {
        cardholder: "",
        channel: "evan-stone",
        customer: "Northwind",
        workspace: "Evan Stone's Workspace",
      },
    ];
    for (const sample of cases) {
      const stub = fake({
        charge: { billing_details: { name: sample.cardholder } },
        slackChannels: [{ id: "G0CLIENT", name: sample.channel }],
        tables: { organization: [{ id: ORG_A, name: sample.workspace }] },
      });
      const { read } = stub.deps;
      // biome-ignore lint/performance/noAwaitInLoops: isolate customer, cardholder, and workspace naming shapes.
      const result = await gatherDisputeEvidence("du_1", {
        ...stub.deps,
        read: async (request, options) => {
          const response = await read(request, options);
          return request.operation === "stripe.customers.get"
            ? {
                ...response,
                data: { ...(response.data as object), name: sample.customer },
              }
            : response;
        },
      });
      assert.equal(facts(result, "slack").channel?.id, "G0CLIENT");
    }
  });

  it("two people with the same full name leave channel ownership ambiguous", async () => {
    const { result, calls } = await gather({
      charge: { billing_details: { name: "Evan Stone" } },
      slackChannels: [
        { id: "G0ONE", name: "evan-stone-one" },
        { id: "G0TWO", name: "evan-stone-two" },
      ],
    });
    assert.equal(result.sources.slack.checked, false);
    assert.equal(calls.includes("slack.aia.history"), false);
  });

  it("finds a domain-only channel when the database fails, and reports a complete no-match as checked", async () => {
    const stub = fake({
      slackChannels: [{ id: "G0DOMAIN", name: "acme-io-client" }],
    });
    const result = await gatherDisputeEvidence("du_1", {
      ...stub.deps,
      sql: () => Promise.reject(new Error("unavailable")),
    });
    assert.equal(facts(result, "slack").channel?.id, "G0DOMAIN");
    const none = await gather({ slackChannels: [] });
    assert.equal(none.result.sources.slack.checked, true);
    assert.equal(facts(none.result, "slack").channel, null);
    assert.ok(facts(none.result, "slack").reason);
  });
});

it("an Instantly rate limit fails only Instantly and retains the provider reason", async () => {
  const stub = fake({
    tables: {
      outreach_provider: [
        { provider: "instantly", workspace_id: WORKSPACE_ID },
      ],
    },
  });
  const { read } = stub.deps;
  const result = await gatherDisputeEvidence("du_1", {
    ...stub.deps,
    read: (request, options) =>
      request.operation === "instantly.workspace-group-members"
        ? Promise.resolve({ data: null, retryAfter: "60", status: 429 })
        : read(request, options),
  });
  assert.ok(!result.sources.instantly.checked);
  assert.ok(result.sources.instantly.error.includes("rate-limited"));
  for (const [name, source] of Object.entries(result.sources)) {
    if (name !== "instantly") {
      assert.equal(source.checked, true, name);
    }
  }
});
