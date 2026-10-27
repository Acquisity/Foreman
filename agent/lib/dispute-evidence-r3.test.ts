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
import {
  type OperationRequest,
  operationInputs,
} from "./executor/operations.js";
import { ExecutorError } from "./executor/transport.js";
import { WORKSPACE_ID } from "./instantly-fixtures.js";

const UNREQUESTED = /only unrequested issues \(1\)/u;

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
  it("keeps history unchanged and identifies the disputed invoice through a separate created window", async () => {
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
        return "created[gte]" in request.input
          ? json({
              data: [
                {
                  amount_paid: 25_200,
                  id: "in_window",
                  lines: {
                    data: [
                      {
                        parent: {
                          subscription_item_details: {
                            subscription: "sub_window",
                          },
                        },
                        period: { end: 2, start: 1 },
                      },
                    ],
                  },
                  status: "paid",
                  status_transitions: { paid_at: CHARGE + 5 },
                },
              ],
              has_more: false,
            })
          : json({ data: [], has_more: true });
      },
    });
    const history = {
      input: { customer: "cus_1", limit: 50 },
      operation: "stripe.invoices.list",
    };
    const window = {
      input: {
        "created[gte]": CHARGE - 172_800,
        "created[lte]": CHARGE + 172_800,
        customer: "cus_1",
        limit: 50,
      },
      operation: "stripe.invoices.list",
    };
    assert.deepEqual(invoices, [history, window]);
    assert.deepEqual(
      operationInputs["stripe.invoices.list"].parse(window.input),
      window.input
    );
    assert.equal(facts(result, "stripe").invoices?.truncated, true);
    assert.equal(facts(result, "stripe").invoiceWindow?.truncated, false);
    assert.equal(
      facts(result, "stripe").chargeInvoice.invoice?.id,
      "in_window"
    );
    assert.equal(result.verdict.deliveryStoppedBeforeCharge.value, true);
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

it("complete invoice-window evidence can disprove stopped delivery despite truncated history", async () => {
  const stub = fake({ charge: { invoice: null, payment_intent: null } });
  const { read } = stub.deps;
  const result = await gatherDisputeEvidence("du_1", {
    ...stub.deps,
    read: (request, options) => {
      if (request.operation !== "stripe.invoices.list") {
        return read(request, options);
      }
      return "created[gte]" in request.input
        ? json({
            data: [
              {
                amount_paid: 25_200,
                id: "in_window",
                lines: {
                  data: [
                    {
                      parent: {
                        subscription_item_details: {
                          subscription: "sub_window",
                        },
                      },
                      period: { end: 2, start: 1 },
                    },
                  ],
                },
                status: "paid",
                status_transitions: { paid_at: CHARGE + 5 },
              },
            ],
            has_more: false,
          })
        : json({ data: [], has_more: true });
    },
  });
  assert.equal(facts(result, "stripe").invoices?.truncated, true);
  assert.equal(result.verdict.deliveryStoppedBeforeCharge.value, false);
  assert.equal(result.verdict.duplicate.value, null);
});
