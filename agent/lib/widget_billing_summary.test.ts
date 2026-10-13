import assert from "node:assert/strict";
import { test } from "node:test";
import type { BillingAccountResult } from "#lib/billing-account.js";
import { verifiedWidgetContext } from "#lib/widget.fixture.js";
import { widgetAuth } from "#lib/widget-scope.js";
import definition, {
  buildBillingAuthorizationQuery,
  buildErroredInboxesQuery,
  composeWidgetBillingSummary,
  readCreditGap,
  readCreditUsage,
  readInboxErrorBilling,
  sessionRead,
  type WidgetBillingSummaryDeps,
  widgetBillingSummaryInputSchema,
  widgetBillingSummaryOutputSchema,
  withInboxCounts,
} from "../tools/widget_billing_summary.js";

const widgetCtx = {
  session: {
    auth: { current: null, initiator: widgetAuth(verifiedWidgetContext) },
  },
};
const otherAuth = {
  attributes: {},
  authenticator: "slack" as const,
  principalId: "user:1",
  principalType: "user" as const,
};
const nonWidgetCtx = {
  session: { auth: { current: null, initiator: otherAuth } },
};
const IDENTITY_REQUIRED = /Support widget identity required/;

const resolveTool = (ctx: unknown) => {
  const events = definition.events as Record<
    string,
    (event: unknown, ctx: unknown) => unknown
  >;
  // biome-ignore lint/style/noNonNullAssertion: the tool only registers step.started
  return events["step.started"]!(undefined, ctx);
};

test("the tool is offered only in a verified widget session", () => {
  assert.notEqual(resolveTool(widgetCtx), null);
  assert.equal(resolveTool(nonWidgetCtx), null);
});

test("approval is not-applicable for widget auth and denied otherwise", () => {
  const tool = resolveTool(widgetCtx) as {
    approval: (ctx: unknown) => unknown;
    execute: (input: unknown, ctx: unknown) => unknown;
  };
  assert.equal(tool.approval(widgetCtx), "not-applicable");
  assert.deepEqual(tool.approval(nonWidgetCtx), {
    reason: "Support widget investigations only.",
    type: "denied",
  });
});

test("execute refuses a non-widget identity before touching any provider", () => {
  const tool = resolveTool(widgetCtx) as {
    execute: (input: unknown, ctx: unknown) => unknown;
  };
  assert.throws(() => tool.execute({}, nonWidgetCtx), IDENTITY_REQUIRED);
});

test("no selector accepts an organization id, customer id or SQL", () => {
  for (const input of [
    { organizationId: "x" },
    { customerId: "cus_x" },
    { query: "select 1" },
  ]) {
    assert.equal(
      widgetBillingSummaryInputSchema.safeParse(input).success,
      false
    );
  }
});

const creditWindow = {
  from: "2026-08-22T00:00:00Z",
  to: "2026-09-22T00:00:00Z",
};

test("credit windows reject injection and reversed dates", () => {
  for (const window of [
    { from: "2026-08-22'", to: creditWindow.to },
    { from: creditWindow.to, to: creditWindow.from },
  ]) {
    assert.equal(
      widgetBillingSummaryInputSchema.safeParse({ creditWindow: window })
        .success,
      false
    );
  }
});

const BASE_BILLING_ACCOUNT: NonNullable<
  BillingAccountResult["billingAccount"]
> = {
  credits: {
    balance: 500,
    lifetimeGranted: 1000,
    lifetimePurchased: 1000,
    lifetimeUsed: 500,
  },
  domains: {
    balance: 0,
    lifetimeGranted: null,
    lifetimePurchased: 0,
    lifetimeUsed: 0,
  },
  firstPaidObservedAt: null,
  firstTrialObservedAt: null,
  id: "acct_123",
  inboxes: {
    balance: 0,
    lifetimeGranted: null,
    lifetimePurchased: 0,
    lifetimeUsed: 0,
  },
  provider: "autumn",
  subscriptionPlan: "growth",
  subscriptionStatus: "active",
  trialEndsAt: null,
  websiteCredits: {
    balance: 0,
    lifetimeGranted: null,
    lifetimePurchased: 0,
    lifetimeUsed: 0,
  },
};

const dbAccount = (
  overrides: Partial<BillingAccountResult> = {}
): BillingAccountResult => ({
  billingAccount: BASE_BILLING_ACCOUNT,
  creditBalances: [],
  found: true,
  manualCredits: [],
  organization: {
    createdAt: "2026-01-01T00:00:00.000Z",
    id: verifiedWidgetContext.organizationId,
    name: verifiedWidgetContext.organizationName,
    partnerGoverned: false,
    partnerId: "00000000-0000-0000-0000-000000000001",
  },
  transactions: [],
  truncated: { manualCredits: false, transactions: false },
  unavailable: [],
  ...overrides,
});

const stripeFixture = {
  balanceTransactions: { data: { data: [], object: "list" } },
  charges: {
    data: {
      data: [
        {
          amount: 4900,
          amount_refunded: 0,
          created: 1_726_000_000,
          currency: "usd",
          description: "Growth plan",
          id: "ch_1",
          refunded: false,
          status: "succeeded",
        },
        {
          amount: 1900,
          amount_refunded: 0,
          created: 1_726_100_000,
          currency: "usd",
          description: "Domain add-on",
          failure_code: "card_declined",
          failure_message:
            "Your card has insufficient funds. Use a different payment method to complete this purchase.",
          id: "ch_2",
          outcome: {
            network_status: "declined_by_network",
            reason: "insufficient_funds",
            risk_score: 12,
            seller_message: "The bank returned the decline code.",
            type: "issuer_declined",
          },
          refunded: false,
          status: "failed",
        },
        {
          amount: 900,
          amount_refunded: 900,
          created: 1_726_200_000,
          currency: "usd",
          description: "Domain renewal",
          id: "ch_3",
          refunded: true,
          status: "succeeded",
        },
      ],
      object: "list",
    },
  },
  creditNotes: { data: { data: [], object: "list" } },
  customer: {
    data: {
      discount: {
        coupon: {
          amount_off: null,
          id: "SAVE10",
          name: "Save 10",
          percent_off: 10,
          valid: true,
        },
      },
      id: "cus_abc",
    },
  },
  invoices: {
    data: {
      data: [
        {
          amount_due: 4900,
          amount_paid: 4900,
          created: 1_726_000_000,
          currency: "usd",
          id: "in_1",
          status: "paid",
        },
      ],
      object: "list",
    },
  },
  subscriptions: {
    data: {
      data: [
        {
          cancel_at_period_end: false,
          current_period_end: 1_729_000_000,
          id: "sub_1",
          status: "active",
          trial_end: null,
        },
      ],
      object: "list",
    },
  },
};

const fakeDeps = (
  overrides: Partial<WidgetBillingSummaryDeps> = {}
): WidgetBillingSummaryDeps & { calls: { organizationId?: string } } => {
  const calls: { organizationId?: string } = {};
  return {
    calls,
    getAutumnCustomer: () => Promise.resolve({ stripe_id: "cus_abc" }),
    getBillingAccount: (organizationId) => {
      calls.organizationId = organizationId;
      return Promise.resolve(dbAccount());
    },
    getStripeCustomerBilling: () => Promise.resolve(stripeFixture),
    isAuthorized: () => Promise.resolve(true),
    ...overrides,
  };
};

test("requested history is scoped, separate from lifetime totals, and unavailable is not zero", async () => {
  const calls: string[] = [];
  const result = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    fakeDeps({
      getCreditHistory: (organizationId, window) => {
        calls.push(organizationId);
        assert.deepEqual(window, creditWindow);
        return Promise.resolve({
          available: true,
          completedManualGrants: [
            { amount: 100, entries: 1, resource: "credits" },
          ],
          transactionTotals: [
            { amount: -50, entries: 2, resource: "credits", type: "usage" },
          ],
          truncated: false,
          window,
        });
      },
    }),
    { creditWindow }
  );
  assert.deepEqual(calls, [verifiedWidgetContext.organizationId]);
  assert.equal(result.creditHistory?.transactionTotals[0].amount, -50);
  assert.equal(result.credits?.lifetimeUsed, 500);
  const unavailable = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    fakeDeps({
      getCreditHistory: () =>
        Promise.reject(new Error("private provider details")),
    }),
    { creditWindow }
  );
  assert.equal(unavailable.creditHistory?.available, false);
  assert.ok(
    unavailable.unavailable.includes("productDb.creditHistory read unavailable")
  );
  assert.equal(
    JSON.stringify(unavailable).includes("private provider details"),
    false
  );
  const denied = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    fakeDeps({
      getCreditHistory: () => assert.fail("must not read another workspace"),
      isAuthorized: () => Promise.resolve(false),
    }),
    { creditWindow }
  );
  assert.equal(denied.available, false);
});

test("a window longer than 93 days is shortened to the 93 days ending at its end, and the result says so", async () => {
  const seen: unknown[] = [];
  const requested = {
    from: "2026-07-01T00:00:00Z",
    to: "2026-10-10T00:00:00Z",
  };
  const result = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    fakeDeps({
      getCreditHistory: (_organizationId, window) => {
        seen.push(window);
        return Promise.resolve({
          available: true,
          completedManualGrants: [],
          transactionTotals: [],
          truncated: false,
          window,
        });
      },
    }),
    { creditWindow: requested }
  );
  const covered = { from: "2026-07-09T00:00:00.000Z", to: requested.to };
  assert.deepEqual(seen, [covered]);
  assert.deepEqual(result.creditHistory?.window, covered);
  assert.ok(
    result.reconciliation.notes.includes(
      "The credit window asked for (2026-07-01T00:00:00Z to 2026-10-10T00:00:00Z) is longer than 93 days, so it was shortened to the 93 days from 2026-07-09T00:00:00.000Z to 2026-10-10T00:00:00Z. Credit activity before 2026-07-09T00:00:00.000Z is not covered."
    )
  );
  // A window within 93 days is read as asked, with no note.
  const exact = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    fakeDeps({
      getCreditHistory: (_organizationId, window) =>
        Promise.resolve({
          available: true,
          completedManualGrants: [],
          transactionTotals: [],
          truncated: false,
          window,
        }),
    }),
    { creditWindow }
  );
  assert.deepEqual(exact.creditHistory?.window, creditWindow);
  assert.equal(
    exact.reconciliation.notes.some((entry) => entry.includes("shortened")),
    false
  );
});

test("missing Autumn Stripe identity does not trigger a guessed customer lookup", async () => {
  const result = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    fakeDeps({
      getAutumnCustomer: () => Promise.resolve({ stripe_id: null }),
      getStripeCustomerBilling: () =>
        assert.fail("no trusted customer identifier"),
    })
  );
  assert.ok(
    result.unavailable.includes("stripe: Autumn record has no stripe_id.")
  );
});

test("a user who is not a live owner or admin, or whose membership cannot be checked, reads no billing at all", async () => {
  for (const isAuthorized of [
    () => Promise.resolve(false),
    () => Promise.reject(new Error("read failed")),
  ]) {
    const deps = fakeDeps({
      getAutumnCustomer: () => assert.fail("must not read Autumn"),
      getBillingAccount: () => assert.fail("must not read the billing account"),
      getStripeCustomerBilling: () => assert.fail("must not read Stripe"),
      isAuthorized,
    });
    // biome-ignore lint/performance/noAwaitInLoops: each case is its own call.
    const result = await composeWidgetBillingSummary(
      verifiedWidgetContext.organizationId,
      deps
    );
    assert.equal(result.available, false);
    assert.equal(result.organization, null);
    assert.deepEqual(result.unavailable, ["workspace could not be verified"]);
  }
});

test("the membership check is scoped to the verified user and workspace", () => {
  const query = buildBillingAuthorizationQuery(verifiedWidgetContext);
  assert.ok(
    query.includes(`o.id = '${verifiedWidgetContext.organizationId}'::uuid`)
  );
  assert.ok(
    query.includes(`m.user_id = '${verifiedWidgetContext.userId}'::uuid`)
  );
  assert.ok(query.includes("m.role in ('owner', 'admin')"));
  assert.ok(query.includes("m.deleted_at is null"));
});

test("resolves the org's customer only from the organization id it was given", async () => {
  const deps = fakeDeps();
  await composeWidgetBillingSummary(verifiedWidgetContext.organizationId, deps);
  assert.equal(deps.calls.organizationId, verifiedWidgetContext.organizationId);
});

test("membership is checked for the same organization the billing read targets", async () => {
  let checked: string | undefined;
  const deps = fakeDeps({
    isAuthorized: (organizationId) => {
      checked = organizationId;
      return Promise.resolve(true);
    },
  });
  await composeWidgetBillingSummary(verifiedWidgetContext.organizationId, deps);
  assert.equal(checked, verifiedWidgetContext.organizationId);
  assert.equal(checked, deps.calls.organizationId);
});

test("a reconciled summary validates against its own output schema", async () => {
  const result = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    fakeDeps()
  );
  assert.doesNotThrow(() => widgetBillingSummaryOutputSchema.parse(result));
  assert.equal(result.available, true);
  assert.deepEqual(result.plan, {
    name: "growth",
    provider: "autumn",
    status: "active",
  });
  assert.equal(result.credits?.balance, 500);
  assert.equal(result.credits?.renewsAt, "2024-10-15T13:46:40.000Z");
  assert.equal(result.recentCharges.length, 3);
  assert.deepEqual(
    result.failedPayments.map((charge) => charge.id),
    ["ch_2"]
  );
  assert.deepEqual(
    result.recentRefunds.map((charge) => charge.id),
    ["ch_3"]
  );
  assert.equal(result.discount?.couponId, "SAVE10");
  assert.equal(result.reconciliation.chargedButNoActiveSubscription, false);
  assert.deepEqual(result.unavailable, []);
});

test("unavailable is not the same as empty when Autumn and Stripe cannot be read", async () => {
  const result = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    fakeDeps({
      getAutumnCustomer: () => Promise.reject(new Error("Autumn timed out.")),
    })
  );
  assert.doesNotThrow(() => widgetBillingSummaryOutputSchema.parse(result));
  assert.equal(result.available, true);
  assert.equal(result.autumn.available, false);
  assert.deepEqual(result.recentCharges, []);
  assert.ok(result.unavailable.some((entry) => entry.startsWith("autumn:")));
  assert.ok(result.unavailable.some((entry) => entry.startsWith("stripe:")));
});

test("a real empty Stripe history is distinct from an unreachable one", async () => {
  const empty = {
    ...stripeFixture,
    charges: { data: { data: [], object: "list" } },
  };
  const result = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    fakeDeps({ getStripeCustomerBilling: () => Promise.resolve(empty) })
  );
  assert.deepEqual(result.recentCharges, []);
  assert.deepEqual(result.unavailable, []);
});

test("a partner-governed organization skips Autumn and Stripe without marking them unavailable", async () => {
  const deps = fakeDeps({
    getBillingAccount: () =>
      Promise.resolve(
        dbAccount({
          organization: {
            createdAt: "2026-01-01T00:00:00.000Z",
            id: verifiedWidgetContext.organizationId,
            name: verifiedWidgetContext.organizationName,
            partnerGoverned: true,
            partnerId: "44444444-4444-4444-8444-444444444444",
          },
        })
      ),
  });
  const result = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    deps
  );
  assert.equal(result.autumn.available, false);
  assert.deepEqual(result.unavailable, []);
  assert.ok(
    result.reconciliation.notes.some((note) => note.includes("partner"))
  );
});

test("an organization that cannot be found in the product database is unavailable, not empty", async () => {
  const result = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    fakeDeps({
      getBillingAccount: () =>
        Promise.resolve({
          billingAccount: null,
          creditBalances: [],
          found: false,
          manualCredits: [],
          organization: null,
          transactions: [],
          truncated: { manualCredits: false, transactions: false },
          unavailable: [],
        }),
    })
  );
  assert.equal(result.available, false);
  assert.ok(result.unavailable.length > 0);
  assert.equal(result.organization, null);
});

test("a succeeded charge with no active subscription status is flagged for reconciliation", async () => {
  const result = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    fakeDeps({
      getBillingAccount: () =>
        Promise.resolve(
          dbAccount({
            billingAccount: {
              ...BASE_BILLING_ACCOUNT,
              subscriptionStatus: null,
            },
          })
        ),
    })
  );
  assert.equal(result.reconciliation.chargedButNoActiveSubscription, true);
  assert.ok(result.reconciliation.notes.length > 0);
});

const ORDER_ID = "0b0e7c1a-1111-4222-8333-444455556666";
const invoiceEvidenceDeps = () =>
  fakeDeps({
    getAutumnCustomer: () =>
      Promise.resolve({
        stripe_id: "cus_abc",
        subscriptions: [
          { id: "pro", status: "active" },
          { id: `${ORDER_ID}-Acme-Mail.com`, status: "active" },
          { id: `${ORDER_ID}-acme-mail.com-inboxes`, status: "active" },
        ],
      }),
    getStripeCustomerBilling: () =>
      Promise.resolve({
        ...stripeFixture,
        invoices: {
          data: {
            data: [
              {
                amount_due: 0,
                amount_paid: 0,
                created: 1_741_000_000,
                ending_balance: 0,
                id: "in_march",
                lines: {
                  data: [{ amount: 0, description: "1 × Pro", quantity: 1 }],
                  has_more: false,
                },
                starting_balance: 0,
                status: "paid",
                total: 0,
              },
              {
                amount_due: 3316,
                amount_paid: 3316,
                charge: "ch_june",
                created: 1_749_000_000,
                id: "in_june",
                lines: {
                  data: [
                    { amount: 1516, description: "1 × Domain", quantity: 1 },
                    { amount: 1800, description: "3 × DFY Inbox", quantity: 3 },
                  ],
                  has_more: true,
                },
                status: "paid",
                status_transitions: { paid_at: 1_749_000_100 },
                total: 3316,
              },
              { created: 1_749_100_000, id: "in_bare", status: "open" },
            ],
            has_more: true,
            object: "list",
          },
        },
      }),
  });

test("a paid invoice that collected nothing is never reported as money collected", async () => {
  const result = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    invoiceEvidenceDeps()
  );
  widgetBillingSummaryOutputSchema.parse(result);
  const [march, june, bare] = result.recentInvoices;
  assert.equal(march?.settlement, "paid_without_money");
  assert.deepEqual(
    march?.lines?.map((line) => line.description),
    ["1 × Pro"]
  );
  assert.equal(march?.customerBalanceAppliedCents, 0);
  assert.equal(june?.settlement, "money_collected");
  assert.equal(june?.chargeId, "ch_june");
  assert.deepEqual(
    june?.lines?.map((line) => [line.description, line.quantity]),
    [
      ["1 × Domain", 1],
      ["3 × DFY Inbox", 3],
    ]
  );
  assert.equal(june?.linesTruncated, true);
  // Missing line items stay unknown instead of reading as an empty invoice.
  assert.equal(bare?.lines, null);
  assert.equal(bare?.settlement, "not_paid");
  assert.equal(bare?.customerBalanceAppliedCents, null);
  assert.deepEqual(result.truncated, [
    "stripe.invoices: older rows exist beyond the ones shown",
  ]);
});

test("order links come only from Acquisity's order-scoped subscription ids", async () => {
  const result = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    invoiceEvidenceDeps()
  );
  assert.deepEqual(result.orderSubscriptions, {
    available: true,
    items: [
      {
        domain: "acme-mail.com",
        kind: "domain",
        orderId: ORDER_ID,
        status: "active",
      },
      {
        domain: "acme-mail.com",
        kind: "inboxes",
        orderId: ORDER_ID,
        status: "active",
      },
    ],
    truncated: false,
  });
  // No invoice carries an order id: attribution is never inferred.
  assert.ok(!JSON.stringify(result.recentInvoices).includes(ORDER_ID));
});

test("order links are unavailable, not empty, when Autumn cannot be read", async () => {
  const result = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    fakeDeps({ getAutumnCustomer: () => Promise.reject(new Error("down")) })
  );
  assert.equal(result.orderSubscriptions.available, false);
});

test("the renewal date comes from a live subscription, never a newer canceled one", async () => {
  const canceled = {
    cancel_at_period_end: false,
    current_period_end: 1_800_000_000,
    id: "sub_0",
    status: "canceled",
    trial_end: null,
  };
  const withSubscriptions = (data: unknown[]) =>
    fakeDeps({
      getStripeCustomerBilling: () =>
        Promise.resolve({
          ...stripeFixture,
          subscriptions: { data: { data, object: "list" } },
        }),
    });
  const live = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    withSubscriptions([canceled, ...stripeFixture.subscriptions.data.data])
  );
  assert.equal(live.credits?.renewsAt, "2024-10-15T13:46:40.000Z");
  const none = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    withSubscriptions([canceled])
  );
  assert.equal(none.credits?.renewsAt, null);
});

const INSUFFICIENT_FUNDS = /insufficient funds/;

test("a failed payment says why it was declined, without risk-screening detail", async () => {
  const result = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    fakeDeps()
  );
  const [failed] = result.failedPayments;
  assert.equal(failed?.declineReason, "insufficient_funds");
  assert.equal(failed?.declineType, "issuer_declined");
  assert.match(failed?.failureMessage ?? "", INSUFFICIENT_FUNDS);
  assert.equal(
    JSON.stringify(result.failedPayments).includes("risk_score"),
    false
  );
  const succeeded = result.recentCharges.find((charge) => charge.id === "ch_1");
  assert.equal(succeeded?.declineReason, null);
  assert.equal(succeeded?.failureMessage, null);
});

test("a payment Stripe's risk screening blocked keeps its reason out of the result", async () => {
  const blocked = {
    amount: 1900,
    created: 1_726_300_000,
    failure_code: "payment_intent_payment_attempt_failed",
    failure_message: "The payment failed.",
    id: "ch_4",
    outcome: { reason: "highest_risk_level", type: "blocked" },
    status: "failed",
  };
  const result = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    fakeDeps({
      getStripeCustomerBilling: () =>
        Promise.resolve({
          ...stripeFixture,
          charges: { data: { data: [blocked], object: "list" } },
        }),
    })
  );
  assert.equal(result.failedPayments[0]?.declineType, "blocked");
  assert.equal(result.failedPayments[0]?.declineReason, null);
  assert.equal(JSON.stringify(result).includes("highest_risk_level"), false);
});

test("inbox lines state how many inboxes they bill from the plan's per-inbox price", async () => {
  // wrun_41M4EBCXG30GWVAHMTAFGQG4GJ said 4 inboxes: each 1 × $18 line is 3 inboxes at $6.
  const line = (description: string, amount: number) => ({
    amount,
    description,
    period: { end: 1_729_000_000, start: 1_726_000_000 },
    quantity: 1,
  });
  const inboxLine = line("1 × Inbox (DFY) - Inboxes (at $18.00 / month)", 1800);
  const invoice = (lines: unknown[]) => ({
    data: {
      data: [
        {
          amount_paid: 13_406,
          created: 1_726_000_000,
          id: "in_1",
          lines: { data: lines },
          status: "paid",
        },
      ],
      object: "list",
    },
  });
  const deps = (
    plans: unknown[],
    lines: unknown[] = [
      line("1 × Domain - Domains (at $16.74 / year)", 1674),
      inboxLine,
      inboxLine,
      inboxLine,
      inboxLine,
    ]
  ) =>
    fakeDeps({
      getAutumnCustomer: () =>
        Promise.resolve({ stripe_id: "cus_abc", subscriptions: plans }),
      getStripeCustomerBilling: () =>
        Promise.resolve({ ...stripeFixture, invoices: invoice(lines) }),
    });
  const dfy = {
    plan: {
      items: [{ feature_id: "inboxes", price: { amount: 6 } }],
      name: "Inbox (DFY)",
    },
  };
  const counted = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    deps([dfy])
  );
  widgetBillingSummaryOutputSchema.parse(counted);
  const [paid] = counted.recentInvoices;
  assert.deepEqual(
    paid?.lines?.map((entry) => entry.inboxCount),
    [null, 3, 3, 3, 3]
  );
  assert.equal(paid?.inboxCount, 12);
  // No per-inbox price, or a count that is not whole, states nothing.
  const unpriced = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    deps([])
  );
  assert.equal(unpriced.recentInvoices[0]?.inboxCount, null);
  const partial = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    deps([dfy], [line("1 × Inbox (DFY) - Inboxes (at $18.00 / month)", 1000)])
  );
  assert.equal(partial.recentInvoices[0]?.inboxCount, null);
});

test("inboxes in error are tied to the inbox charges covering time after the error began", async () => {
  // wrun_41M4GJGQB60GNM5W8B3MAF4Z47 listed the errors and the charges and never tied them.
  const month = (created: string, start: string, end: string) => ({
    amount_paid: 34_500,
    created: Date.parse(created) / 1000,
    id: `in_${created}`,
    lines: {
      data: [
        {
          amount: 4800,
          description: "6 × Inbox - Inboxes (at $8.00 / month)",
          period: {
            end: Date.parse(end) / 1000,
            start: Date.parse(start) / 1000,
          },
          quantity: 6,
        },
        {
          amount: 29_700,
          description: "1 × Pro (at $297.00 / month)",
          period: {
            end: Date.parse(end) / 1000,
            start: Date.parse(start) / 1000,
          },
          quantity: 1,
        },
      ],
    },
    status: "paid",
  });
  const deps = (errored: { count: number; since: string | null }) =>
    fakeDeps({
      getErroredInboxes: () => Promise.resolve(errored),
      getStripeCustomerBilling: () =>
        Promise.resolve({
          ...stripeFixture,
          invoices: {
            data: {
              data: [
                month(
                  "2026-10-01T00:00:00Z",
                  "2026-10-01T00:00:00Z",
                  "2026-11-01T00:00:00Z"
                ),
                month(
                  "2026-09-01T00:00:00Z",
                  "2026-09-01T00:00:00Z",
                  "2026-10-01T00:00:00Z"
                ),
                month(
                  "2026-08-01T00:00:00Z",
                  "2026-08-01T00:00:00Z",
                  "2026-09-01T00:00:00Z"
                ),
              ],
              object: "list",
            },
          },
        }),
    });
  const tied = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    deps({ count: 6, since: "2026-09-17T09:00:00.000+00:00" })
  );
  widgetBillingSummaryOutputSchema.parse(tied);
  assert.equal(
    tied.reading,
    "6 of the purchased inboxes have been in error since 2026-09-17 (the latest of their first saved errors), and the workspace was billed for inbox charges covering time after that: 2026-10-01 ($48.00), 2026-09-01 ($48.00). These are billing facts; they decide nothing about a refund or credit."
  );
  assert.equal(tied.identifiesCharge, true);
  // No inbox in error, or an error after every billed period, ties nothing.
  const quiet = await Promise.all(
    [
      { count: 0, since: null },
      { count: 2, since: "2026-11-02T00:00:00.000+00:00" },
    ].map((errored) =>
      composeWidgetBillingSummary(
        verifiedWidgetContext.organizationId,
        deps(errored)
      )
    )
  );
  for (const result of quiet) {
    assert.equal(result.reading, undefined);
    assert.equal(result.identifiesCharge, undefined);
  }
  const failed = await composeWidgetBillingSummary(
    verifiedWidgetContext.organizationId,
    fakeDeps({ getErroredInboxes: () => Promise.reject(new Error("down")) })
  );
  assert.ok(
    failed.unavailable.includes("productDb.erroredInboxes read failed")
  );
});

test("the errored-inbox read is scoped to the verified owner or admin and leaves out cancelled inboxes", () => {
  const query = buildErroredInboxesQuery(verifiedWidgetContext);
  assert.ok(query.includes(verifiedWidgetContext.userId));
  assert.ok(query.includes("m.role in ('owner', 'admin')"));
  assert.ok(query.includes("join authorized a on a.id = mi.organization_id"));
  assert.ok(query.includes("!~* '(cancel|removed)'"));
});

test("a repeated billing read in one session reuses the first, until it fails or goes stale", async () => {
  let reads = 0;
  const read = () => {
    reads += 1;
    return Promise.resolve(reads);
  };
  const at = 1_000_000;
  assert.equal(await sessionRead("s1:stripe:cus", read, at), 1);
  assert.equal(await sessionRead("s1:stripe:cus", read, at + 60_000), 1);
  // Another session, or another customer, reads for itself.
  assert.equal(await sessionRead("s2:stripe:cus", read, at), 2);
  // Three minutes on, a later turn reads billing afresh.
  assert.equal(await sessionRead("s1:stripe:cus", read, at + 181_000), 3);
  const failed = sessionRead(
    "s1:autumn:cus",
    () => Promise.reject(new Error("down")),
    at
  );
  await assert.rejects(failed);
  assert.equal(await sessionRead("s1:autumn:cus", read, at), 4);
});

test("a gap between the provider's credit balance and the product ledger is a reading with both numbers", () => {
  const autumn = (remaining: number, usage: number) => ({
    balances: { credits: { granted: 10_000, remaining, usage } },
  });
  const wallet = {
    balance: -630,
    lifetimeGranted: 0,
    lifetimePurchased: 0,
    lifetimeUsed: 630,
  };
  // wrun ...35DNCX: the customer saw 8,017, which is 8,647 less the ledger's 630.
  assert.equal(
    readCreditGap(autumn(8647, 1353), wallet),
    "The billing provider counts 10,000 credits granted, 1,353 used and 8,647 remaining. The product's own credit ledger records a balance of -630 credits and 630 lifetime credits used. Together, the provider's remaining balance and the ledger balance come to 8,017 credits. Lead credits and website credits come from one shared pool, so check how many credits went to websites before calling a difference a double count."
  );
  // Agreeing balances, no ledger usage, or no provider record: no reading.
  assert.equal(
    readCreditGap(autumn(9370, 630), { ...wallet, balance: 9370 }),
    null
  );
  assert.equal(
    readCreditGap(autumn(8647, 1353), { ...wallet, lifetimeUsed: 0 }),
    null
  );
  assert.equal(readCreditGap(undefined, wallet), null);
});

test("the ledger's credit usage is read by what each entry was spent on", () => {
  const usage = (reference_type: string | null, amount: number) => ({
    amount,
    reference_type,
    resource: "credits",
    type: "usage",
  });
  const spent = readCreditUsage(
    [
      ...Array.from({ length: 8 }, () => usage("campaign_lead_ingestion", -70)),
      usage("website_agent_run", -70),
      usage(null, -5),
      { amount: 500, resource: "credits", type: "grant" },
      { ...usage("campaign_lead_ingestion", -9), resource: "inboxes" },
    ],
    false
  );
  assert.equal(
    spent,
    "The ledger records that credit usage as 560 for leads added to campaigns (8 entries); 70 for website builder runs (1 entry); 5 for usage with no recorded source (1 entry)."
  );
  assert.ok(
    readCreditUsage([usage("llm_usage", -3)], true)?.startsWith(
      "In its most recent entries, the ledger records"
    )
  );
  assert.equal(readCreditUsage([], false), null);
  const gap = readCreditGap(
    {
      balances: { credits: { granted: 10_000, remaining: 8157, usage: 1843 } },
    },
    { balance: -630, lifetimeUsed: 630 },
    spent
  );
  assert.ok(gap?.includes(`credits. ${spent} Lead credits`));
});

test("inbox error billing does not attribute another order's invoice to the errored inbox", () => {
  const reading = readInboxErrorBilling(
    { count: 1, since: "2026-10-01T00:00:00Z" },
    [
      {
        ...invoiceForErrorTest,
        lines: [
          {
            ...invoiceForErrorTest.lines[0],
            description: "Inboxes for another order",
          },
        ],
      },
    ]
  );
  assert.ok(
    reading?.includes(
      "the workspace was billed for inbox charges covering time after that"
    )
  );
  assert.equal(reading?.includes("for them"), false);
});

test("prorated inbox charges do not become a smaller inbox count", () => {
  const counted = withInboxCounts(
    {
      ...invoiceForErrorTest,
      lines: [
        {
          ...invoiceForErrorTest.lines[0],
          amountCents: 600,
          description: "Remaining time on 3 × Inbox Plan - inboxes",
          proration: true,
          quantity: 3,
        },
      ],
    },
    new Map([["Inbox Plan", 600]])
  );
  assert.equal(counted.lines?.[0].inboxCount, null);
  assert.equal(counted.inboxCount, null);
});

const invoiceForErrorTest = {
  amountDueCents: 1800,
  amountPaidCents: 1800,
  amountRemainingCents: 0,
  billingReason: null,
  chargeId: null,
  createdAt: "2026-10-02T00:00:00Z",
  currency: "usd",
  customerBalanceAppliedCents: null,
  discountCents: null,
  id: "in_fixture",
  inboxCount: null,
  lines: [
    {
      amountCents: 1800,
      description: "3 inboxes",
      inboxCount: null,
      periodEnd: "2026-11-01T00:00:00Z",
      periodStart: "2026-10-01T00:00:00Z",
      proration: false,
      quantity: 3,
    },
  ],
  linesTruncated: false,
  paidAt: "2026-10-02T00:00:00Z",
  settlement: "money_collected" as const,
  status: "paid",
  totalCents: 1800,
};

test("credit readings combine the offset balance without inventing a lifetime-usage gap", () => {
  const reading = readCreditGap(
    { balances: { credits: { granted: 1000, remaining: 800, usage: 200 } } },
    { balance: 790, lifetimeUsed: 300 }
  );
  assert.ok(reading?.includes("come to 1,590 credits"));
  assert.ok(
    reading?.includes("balance of 790 credits and 300 lifetime credits used")
  );
  assert.equal(reading?.includes("the gap"), false);
  assert.equal(reading?.includes("500"), false);
  const offset = readCreditGap(
    {
      balances: { credits: { granted: 10_000, remaining: 8647, usage: 1353 } },
    },
    { balance: -630, lifetimeUsed: 630 }
  );
  assert.ok(offset?.includes("come to 8,017 credits"));
});

test("resolved billing failures and unavailable results are not cached", async () => {
  await Promise.all(
    [{ available: true, error: "down" }, { available: false }].map(
      async (failure) => {
        let reads = 0;
        const read = () => {
          reads += 1;
          return Promise.resolve(reads === 1 ? failure : { available: true });
        };
        const cacheable = (value: { error?: string; available: boolean }) =>
          !value.error && value.available;
        const key = `resolved-failure:${failure.error ?? "unavailable"}`;
        assert.deepEqual(
          await sessionRead(key, read, 1_000_000, cacheable),
          failure
        );
        assert.deepEqual(await sessionRead(key, read, 1_001_000, cacheable), {
          available: true,
        });
        assert.deepEqual(await sessionRead(key, read, 1_002_000, cacheable), {
          available: true,
        });
        assert.equal(reads, 2);
      }
    )
  );
});
