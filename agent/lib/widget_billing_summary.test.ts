import assert from "node:assert/strict";
import { test } from "node:test";
import type { BillingAccountResult } from "#lib/billing-account.js";
import { verifiedWidgetContext } from "#lib/widget.fixture.js";
import { widgetAuth } from "#lib/widget-scope.js";
import definition, {
  buildBillingAuthorizationQuery,
  composeWidgetBillingSummary,
  type WidgetBillingSummaryDeps,
  widgetBillingSummaryInputSchema,
  widgetBillingSummaryOutputSchema,
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

test("credit windows reject injection, reversed dates, and unbounded periods", () => {
  for (const window of [
    { from: "2026-08-22'", to: creditWindow.to },
    { from: creditWindow.to, to: creditWindow.from },
    { from: "2025-01-01T00:00:00Z", to: creditWindow.to },
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
          id: "ch_2",
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
