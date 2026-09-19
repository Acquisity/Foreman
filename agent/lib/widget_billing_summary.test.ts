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
  assert.deepEqual(Object.keys(widgetBillingSummaryInputSchema.shape), []);
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
