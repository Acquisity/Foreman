import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConnectionAuthorizationFailedError } from "eve/connections";
import {
  CHARGE,
  facts,
  fake,
  gather,
  json,
  ORG_A,
} from "./__tests__/dispute-evidence-fixtures.js";
import { gatherDisputeEvidence } from "./dispute-evidence.js";
import type { OperationRequest } from "./executor/operations.js";
import { ExecutorError } from "./executor/transport.js";
import { WORKSPACE_ID } from "./instantly-fixtures.js";

const UNREQUESTED = /only unrequested issues \(1\)/u;
const DISPUTED_INVOICE = {
  amount_paid: 25_200,
  created: CHARGE - 3600,
  id: "in_disputed",
  lines: {
    data: [
      {
        parent: { subscription_item_details: { subscription: "sub_window" } },
        period: { end: 2, start: 1 },
      },
    ],
  },
  status: "paid",
  status_transitions: { paid_at: CHARGE + 5 },
};
const OLD_INVOICE = {
  amount_paid: 25_200,
  created: CHARGE - 60 * 86_400,
  id: "in_old",
  lines: { data: [] },
  status: "paid",
  status_transitions: { paid_at: CHARGE - 60 * 86_400 },
};

describe("Linear live replay regressions", () => {
  it("requests IssueBodies by identifier through id in", async () => {
    const stub = fake();
    const { linear } = stub.deps;
    const requests: OperationRequest[] = [];
    await gatherDisputeEvidence("du_1", {
      ...stub.deps,
      linear: (request, options) => {
        requests.push(request);
        return linear(request, options);
      },
    });
    assert.deepEqual(
      requests.find((request) => request.operation === "linear.IssueBodies")
        ?.input,
      { variables: { filter: { id: { in: ["CSP-12"] } } } }
    );
  });

  it("fails when IssueBodies returns only unrequested identifiers", async () => {
    const stub = fake();
    const { linear } = stub.deps;
    const result = await gatherDisputeEvidence("du_1", {
      ...stub.deps,
      linear: async (request, options) => {
        const response = await linear(request, options);
        if (request.operation !== "linear.IssueBodies") {
          return response;
        }
        const body = response.data as {
          data: { issues: { nodes: { identifier: string }[] } };
        };
        body.data.issues.nodes[0].identifier = "ENG-999999";
        return response;
      },
    });
    assert.ok(!result.sources.linear.checked);
    assert.match(result.sources.linear.error, UNREQUESTED);
  });

  it("drops and counts mixed unrequested issues before ownership matching", async () => {
    const stub = fake();
    const { linear } = stub.deps;
    const result = await gatherDisputeEvidence("du_1", {
      ...stub.deps,
      linear: async (request, options) => {
        const response = await linear(request, options);
        if (request.operation === "linear.IssueBodies") {
          const body = response.data as {
            data: { issues: { nodes: { identifier: string }[] } };
          };
          body.data.issues.nodes.push({
            ...body.data.issues.nodes[0],
            identifier: "ENG-999999",
          });
        }
        return response;
      },
    });
    const source = facts(result, "linear");
    assert.deepEqual(
      source.tickets.rows.map((ticket) => ticket.identifier),
      ["CSP-12"]
    );
    assert.equal(source.droppedUnrequested, 1);
    assert.equal(source.droppedCandidates, 1);
  });

  it("accepts a different-email ticket naming the exact full workspace", async () => {
    const { result } = await gather({
      linearDescription:
        "Already offboarded Harbor Light's Workspace; contact different@example.test",
      tables: {
        organization: [{ id: ORG_A, name: "Harbor Light's Workspace" }],
      },
    });
    assert.deepEqual(facts(result, "linear").tickets.rows[0]?.matchedOn, [
      "workspaceName",
    ]);
  });

  it("accepts a whole full-name match and reports its weaker rule", async () => {
    const { result } = await gather({
      charge: { billing_details: { name: "Mira Patel" } },
      linearDescription: "Mira Patel has already offboarded",
    });
    assert.deepEqual(facts(result, "linear").tickets.rows[0]?.matchedOn, [
      "cardholderName",
    ]);
  });

  it("rejects a single-word Growth workspace and partial workspace or person names", async () => {
    const cases = [
      {
        name: "Growth",
        person: "Mira Patel",
        text: "Growth plan refund for another client",
      },
      {
        name: "Harbor Light's Workspace",
        person: "Mira Patel",
        text: "Harbor Light requested a refund",
      },
      { name: "Acme", person: "Mira Patel", text: "Mira requested a refund" },
    ];
    for (const sample of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: isolate the three ownership counterexamples.
      const { result } = await gather({
        charge: { billing_details: { name: sample.person } },
        linearDescription: sample.text,
        tables: { organization: [{ id: ORG_A, name: sample.name }] },
      });
      assert.equal(facts(result, "linear").tickets.rows.length, 0, sample.text);
    }
  });

  it("accepts exact member email and the full owner name", async () => {
    const tables = {
      member: [
        { email: "member@harbor.test", name: "Nora Reed", role: "owner" },
      ],
    };
    const email = await gather({
      linearDescription: "Contact member@harbor.test about this refund",
      tables,
    });
    assert.deepEqual(facts(email.result, "linear").tickets.rows[0]?.matchedOn, [
      "memberEmail",
    ]);
    const owner = await gather({
      linearDescription: "Nora Reed has already offboarded",
      tables,
    });
    assert.deepEqual(facts(owner.result, "linear").tickets.rows[0]?.matchedOn, [
      "ownerName",
    ]);
  });
});

describe("invoice and configuration replay regressions", () => {
  it("identifies the disputed invoice from a truncated page that reaches past the lookback", async () => {
    const stub = fake({
      charge: { invoice: null, payment_intent: null },
      subscriptions: [{ canceled_at: CHARGE - 1, id: "sub_window" }],
    });
    const { read } = stub.deps;
    const invoices: OperationRequest[] = [];
    const result = await gatherDisputeEvidence("du_1", {
      ...stub.deps,
      read: (request, options) => {
        if (request.operation !== "stripe.invoices.list") {
          return read(request, options);
        }
        invoices.push(request);
        return json({ data: [DISPUTED_INVOICE, OLD_INVOICE], has_more: true });
      },
    });
    assert.deepEqual(invoices, [
      {
        input: { customer: "cus_1", limit: 50 },
        operation: "stripe.invoices.list",
      },
    ]);
    assert.equal(facts(result, "stripe").invoices?.truncated, true);
    assert.equal(
      facts(result, "stripe").chargeInvoice.invoice?.id,
      "in_disputed"
    );
    assert.equal(result.verdict.deliveryStoppedBeforeCharge.value, true);
  });

  it("leaves the disputed invoice unknown when a truncated page stops inside the lookback", async () => {
    const stub = fake({ charge: { invoice: null, payment_intent: null } });
    const { read } = stub.deps;
    const result = await gatherDisputeEvidence("du_1", {
      ...stub.deps,
      read: (request, options) =>
        request.operation === "stripe.invoices.list"
          ? json({ data: [DISPUTED_INVOICE], has_more: true })
          : read(request, options),
    });
    assert.equal(facts(result, "stripe").chargeInvoice.invoice, null);
    assert.ok(facts(result, "stripe").chargeInvoice.reason);
    assert.equal(result.verdict.duplicate.value, null);
  });

  it("preserves configuration error codes through fixed-sentence provider wrappers", async () => {
    for (const code of [
      "operation_not_bound",
      "operation_bindings_missing",
      "invalid_operation_bindings",
    ]) {
      const stub = fake();
      const { read, linear, slack } = stub.deps;
      const fault = () => Promise.reject(new ExecutorError(code));
      // biome-ignore lint/performance/noAwaitInLoops: isolate the three operator configuration failures.
      const result = await gatherDisputeEvidence("du_1", {
        ...stub.deps,
        linear: (request, options) =>
          request.operation === "linear.RelatedIssues"
            ? fault()
            : linear(request, options),
        read: (request, options) =>
          request.operation === "autumn.customer"
            ? fault()
            : read(request, options),
        slack: (request, options) =>
          request.operation === "slack.aia.channels"
            ? fault()
            : slack(request, options),
      });
      for (const name of ["autumn", "linear", "slack"] as const) {
        const source = result.sources[name];
        assert.ok(!source.checked);
        assert.ok(source.error.includes(code), name);
      }
    }
  });

  it("preserves an Instantly configuration code after its transport wrapper", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const stub = fake({
      tables: {
        outreach_provider: [
          { provider: "instantly", workspace_id: WORKSPACE_ID },
        ],
      },
    });
    const { read } = stub.deps;
    const pending = gatherDisputeEvidence("du_1", {
      ...stub.deps,
      read: (request, options) =>
        request.operation === "instantly.workspace-group-members"
          ? Promise.reject(new ExecutorError("operation_not_bound"))
          : read(request, options),
    });
    // Let each helper retry schedule its existing timer; no real network or wait.
    for (let turn = 0; turn < 5; turn += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: advance each retry after its promise callbacks settle.
      await new Promise<void>((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1500);
    }
    const result = await pending;
    assert.ok(!result.sources.instantly.checked);
    assert.ok(result.sources.instantly.error.includes("operation_not_bound"));
  });
});

it("preserves missing Executor configuration through the Autumn error wrapper", async () => {
  const stub = fake();
  const { read } = stub.deps;
  const result = await gatherDisputeEvidence("du_1", {
    ...stub.deps,
    read: (request, options) =>
      request.operation === "autumn.customer"
        ? Promise.reject(
            new ConnectionAuthorizationFailedError("executor", {
              reason: "executor_not_configured",
              retryable: false,
            })
          )
        : read(request, options),
  });
  assert.ok(!result.sources.autumn.checked);
  assert.ok(result.sources.autumn.error.includes("executor_not_configured"));
});

it("a covering truncated page can disprove stopped delivery", async () => {
  const stub = fake({ charge: { invoice: null, payment_intent: null } });
  const { read } = stub.deps;
  const result = await gatherDisputeEvidence("du_1", {
    ...stub.deps,
    read: (request, options) =>
      request.operation === "stripe.invoices.list"
        ? json({ data: [DISPUTED_INVOICE, OLD_INVOICE], has_more: true })
        : read(request, options),
  });
  assert.equal(facts(result, "stripe").invoices?.truncated, true);
  assert.equal(result.verdict.deliveryStoppedBeforeCharge.value, false);
});

describe("duplicate candidates from live charge histories", () => {
  const period = { end: CHARGE + 30 * 86_400, start: CHARGE };
  const billed = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    lines: { data: [{ period, subscription: "sub_1" }] },
    subscription: "sub_1",
    ...extra,
  });
  const unrefunded = (id: string, created: number, amount = 18_500) => ({
    amount,
    amount_refunded: 0,
    created,
    id,
    status: "succeeded",
  });

  it("a charge with no invoice in a complete page billed no subscription item", async () => {
    const { result } = await gather({
      charges: [unrefunded("ch_oneoff", CHARGE - 3600, 14_400)],
      invoices: [billed("in_1")],
    });
    assert.equal(result.verdict.duplicate.value, false);
  });

  it("ignores charges older than the lookback before the billed period", async () => {
    const stub = fake({
      charges: [unrefunded("ch_april", CHARGE - 180 * 86_400)],
    });
    const { read } = stub.deps;
    const result = await gatherDisputeEvidence("du_1", {
      ...stub.deps,
      read: (request, options) =>
        request.operation === "stripe.invoices.list"
          ? json({ data: [billed("in_1"), OLD_INVOICE], has_more: true })
          : read(request, options),
    });
    assert.equal(result.verdict.duplicate.value, false);
  });

  it("stays unknown when a candidate charge matches several invoices", async () => {
    const paid = { amount_paid: 18_500, status: "paid" };
    const { result } = await gather({
      charges: [unrefunded("ch_2", CHARGE - 3600)],
      invoices: [
        billed("in_1"),
        billed("in_a", {
          ...paid,
          status_transitions: { paid_at: CHARGE - 3590 },
        }),
        billed("in_b", {
          ...paid,
          status_transitions: { paid_at: CHARGE - 3610 },
        }),
      ],
    });
    assert.equal(result.verdict.duplicate.value, null);
  });
});

it("a failed author name lookup leaves the Slack source checked", async () => {
  const stub = fake();
  const { slack } = stub.deps;
  const result = await gatherDisputeEvidence("du_1", {
    ...stub.deps,
    slack: (request, options) =>
      request.operation === "slack.aia.user"
        ? Promise.reject(new ExecutorError("execution_not_dispatched"))
        : slack(request, options),
  });
  assert.equal(result.sources.slack.checked, true);
  const read = facts(result, "slack");
  assert.ok(read.messages.rows.length > 0);
  assert.ok(read.messages.rows.every((message) => message.author === null));
  assert.ok(read.unresolvedAuthors > 0);
});
