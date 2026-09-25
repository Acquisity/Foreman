import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import {
  type BillingAccountResult,
  type CreditHistoryResult,
  type CreditHistoryWindow,
  creditHistoryResultSchema,
  creditHistoryWindowSchema,
  readBillingAccount,
  readBillingCreditHistory,
} from "#lib/billing-account.js";
import {
  readAutumnCustomer,
  readStripeCustomerBilling,
} from "#lib/billing-api.js";
import { executorClient } from "#lib/executor/client.js";
import { PRODUCTION_READ_QUERY_ARGS } from "#lib/lookup-customer.js";
import {
  callPlanetscaleReadQuery,
  parseReadQueryResult,
} from "#lib/planetscale.js";
import {
  isWidgetSupport,
  type WidgetContext,
  widgetContext,
  widgetContextSchema,
} from "#lib/widget-scope.js";

/** Subscription statuses read as "the customer is currently paying for this". */
const ACTIVE_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "past_due",
  "trialing",
]);
const STRIPE_CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/u;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const asText = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const asUnixIso = (value: unknown): string | null =>
  typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : null;
const asRow = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

const chargeSummarySchema = z.object({
  amountCents: z.number().nullable(),
  amountRefundedCents: z.number().nullable(),
  createdAt: z.string().nullable(),
  currency: z.string().nullable(),
  description: z.string().nullable(),
  id: z.string(),
  refunded: z.boolean(),
  status: z.string().nullable(),
});
type ChargeSummary = z.infer<typeof chargeSummarySchema>;

const MAX_INVOICE_LINES = 10;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_ORDER_SUBSCRIPTIONS = 50;

const invoiceLineSchema = z.object({
  amountCents: z.number().nullable(),
  description: z.string().nullable(),
  periodEnd: z.string().nullable(),
  periodStart: z.string().nullable(),
  proration: z.boolean().nullable(),
  quantity: z.number().nullable(),
});

const invoiceSummarySchema = z.object({
  amountDueCents: z.number().nullable(),
  amountPaidCents: z.number().nullable(),
  amountRemainingCents: z.number().nullable(),
  billingReason: z.string().nullable(),
  chargeId: z
    .string()
    .nullable()
    .describe(
      "Stripe charge this invoice names as its payment; matches an id in recentCharges. null means Stripe named none here, not that none exists"
    ),
  createdAt: z.string().nullable(),
  currency: z.string().nullable(),
  customerBalanceAppliedCents: z
    .number()
    .nullable()
    .describe(
      "Stripe customer credit balance this invoice consumed (ending minus starting balance); null when Stripe did not report both"
    ),
  discountCents: z.number().nullable(),
  id: z.string(),
  lines: z
    .array(invoiceLineSchema)
    .max(MAX_INVOICE_LINES)
    .nullable()
    .describe(
      "What the invoice billed for. null means Stripe returned no line items, never that the invoice was empty"
    ),
  linesTruncated: z.boolean(),
  paidAt: z.string().nullable(),
  settlement: z
    .enum(["money_collected", "paid_without_money", "not_paid", "unknown"])
    .describe(
      "money_collected: paid and amountPaidCents is above zero. paid_without_money: Stripe marks it paid but collected nothing (zero total, discount, or credit). Neither proves which order an invoice paid for"
    ),
  status: z.string().nullable(),
  totalCents: z.number().nullable(),
});

const orderSubscriptionSchema = z.object({
  domain: z.string(),
  kind: z.enum(["domain", "inboxes"]),
  orderId: z.string(),
  status: z.string().nullable(),
});

const subscriptionSummarySchema = z.object({
  cancelAtPeriodEnd: z.boolean().nullable(),
  currentPeriodEnd: z.string().nullable(),
  id: z.string(),
  status: z.string().nullable(),
  trialEnd: z.string().nullable(),
});

const discountSummarySchema = z.object({
  amountOffCents: z.number().nullable(),
  couponId: z.string().nullable(),
  name: z.string().nullable(),
  percentOff: z.number().nullable(),
  valid: z.boolean().nullable(),
});

const walletSchema = z.object({
  balance: z.number(),
  lifetimeGranted: z.number().nullable(),
  lifetimePurchased: z.number(),
  lifetimeUsed: z.number(),
});

export const widgetBillingSummaryInputSchema = z.strictObject({
  creditWindow: creditHistoryWindowSchema
    .optional()
    .describe(
      "Optional credit ledger window, from inclusive and to exclusive, at most 93 days. Does not filter Stripe lists or current/lifetime balances."
    ),
});
export type WidgetBillingSummaryInput = z.infer<
  typeof widgetBillingSummaryInputSchema
>;

export const widgetBillingSummaryOutputSchema = z.object({
  autumn: z.object({
    available: z.boolean(),
    data: z.unknown().optional(),
    reason: z.string().optional(),
  }),
  available: z.boolean(),
  creditHistory: creditHistoryResultSchema
    .nullable()
    .describe(
      "Requested workspace-only database ledger aggregates; null means not requested. Transaction amounts retain their signed values, grouped by type and resource. Completed manual grants use completed_at; transactions use created_at. These sources can overlap: never add manual grants to transaction totals. Does not prove complete Autumn usage or include other workspaces sharing the billing account."
    ),
  credits: walletSchema.extend({ renewsAt: z.string().nullable() }).nullable(),
  discount: discountSummarySchema.nullable(),
  failedPayments: z.array(chargeSummarySchema),
  orderSubscriptions: z
    .object({
      available: z.boolean(),
      items: z.array(orderSubscriptionSchema).max(MAX_ORDER_SUBSCRIPTIONS),
      truncated: z.boolean(),
    })
    .describe(
      "Autumn subscriptions whose id Acquisity built as <orderId>-<domain> or <orderId>-<domain>-inboxes at checkout. Proves a billing subscription was created for that order and domain. It does not say which invoice or charge paid it, and orders from before this id format, partner orders, and orders covered by an existing entitlement never appear"
    ),
  organization: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      partnerGoverned: z.boolean(),
    })
    .nullable(),
  plan: z
    .object({
      name: z.string().nullable(),
      provider: z.string().nullable(),
      status: z.string().nullable(),
    })
    .nullable(),
  recentCharges: z.array(chargeSummarySchema),
  recentInvoices: z.array(invoiceSummarySchema),
  recentRefunds: z.array(chargeSummarySchema),
  reconciliation: z.object({
    chargedButNoActiveSubscription: z.boolean(),
    notes: z.array(z.string()),
  }),
  stripeSubscriptions: z.array(subscriptionSummarySchema),
  /** Stripe lists that hit their page limit: older rows exist that are not shown. */
  truncated: z.array(z.string()),
  /** Sections that could not be verified. Never read a matching empty array as zero. */
  unavailable: z.array(z.string()),
});
export type WidgetBillingSummary = z.infer<
  typeof widgetBillingSummaryOutputSchema
>;

type StripeSection = { data?: unknown; error?: string } | undefined;
type StripeBilling = Record<string, { data?: unknown; error?: string }>;

const stripeListRows = (section: StripeSection): Record<string, unknown>[] => {
  const rows = asRow(section?.data).data;
  return Array.isArray(rows) ? rows.map(asRow) : [];
};

const toChargeSummary = (row: Record<string, unknown>): ChargeSummary => ({
  amountCents: asNumber(row.amount),
  amountRefundedCents: asNumber(row.amount_refunded),
  createdAt: asUnixIso(row.created),
  currency: asText(row.currency),
  description: asText(row.description),
  id: asText(row.id) ?? "",
  refunded: row.refunded === true,
  status: asText(row.status),
});

const stripeListHasMore = (section: StripeSection): boolean =>
  asRow(section?.data).has_more === true;

/** A Stripe reference is either the bare id or the expanded object. */
const asStripeId = (value: unknown): string | null =>
  asText(value) ?? asText(asRow(value).id);

const toInvoiceLine = (
  row: Record<string, unknown>
): z.infer<typeof invoiceLineSchema> => {
  const period = asRow(row.period);
  return {
    amountCents: asNumber(row.amount),
    description:
      asText(row.description)?.slice(0, MAX_DESCRIPTION_LENGTH) ?? null,
    periodEnd: asUnixIso(period.end),
    periodStart: asUnixIso(period.start),
    proration: typeof row.proration === "boolean" ? row.proration : null,
    quantity: asNumber(row.quantity),
  };
};

const invoiceSettlement = (
  status: string | null,
  amountPaid: number | null
): z.infer<typeof invoiceSummarySchema>["settlement"] => {
  if (status === "paid") {
    if (amountPaid === null) {
      return "unknown";
    }
    return amountPaid > 0 ? "money_collected" : "paid_without_money";
  }
  return status === null ? "unknown" : "not_paid";
};

const toInvoiceSummary = (
  row: Record<string, unknown>
): z.infer<typeof invoiceSummarySchema> => {
  const lineList = asRow(row.lines);
  const lineRows = Array.isArray(lineList.data)
    ? lineList.data.map(asRow)
    : null;
  const starting = asNumber(row.starting_balance);
  const ending = asNumber(row.ending_balance);
  const discounts = Array.isArray(row.total_discount_amounts)
    ? row.total_discount_amounts
    : null;
  const status = asText(row.status);
  const amountPaidCents = asNumber(row.amount_paid);
  return {
    amountDueCents: asNumber(row.amount_due),
    amountPaidCents,
    amountRemainingCents: asNumber(row.amount_remaining),
    billingReason: asText(row.billing_reason),
    chargeId: asStripeId(row.charge),
    createdAt: asUnixIso(row.created),
    currency: asText(row.currency),
    customerBalanceAppliedCents:
      starting !== null && ending !== null ? ending - starting : null,
    discountCents:
      discounts?.reduce(
        (sum: number, entry) => sum + (asNumber(asRow(entry).amount) ?? 0),
        0
      ) ?? null,
    id: asText(row.id) ?? "",
    lines: lineRows?.slice(0, MAX_INVOICE_LINES).map(toInvoiceLine) ?? null,
    linesTruncated:
      lineList.has_more === true || (lineRows?.length ?? 0) > MAX_INVOICE_LINES,
    paidAt: asUnixIso(asRow(row.status_transitions).paid_at),
    settlement: invoiceSettlement(status, amountPaidCents),
    status,
    totalCents: asNumber(row.total),
  };
};

// Acquisity's checkout names each DFY and pre-warmed subscription
// `${orderId}-${domain}` plus an `-inboxes` twin (buildAutumnDomainSubscriptionId
// in apps/web/lib/billing/providers/autumn/subscription-ids.ts). The order row
// stores no invoice, charge or payment id, so this id is the only verifiable
// order link. Dates, amounts and paidAt are never used to attribute a payment.
const ORDER_SUBSCRIPTION_ID =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(.{1,253}?)(-inboxes)?$/u;

/** Autumn reports subscription ids under several keys depending on API version; read the ones Acquisity itself reads. */
const toOrderSubscriptions = (
  data: unknown
): z.infer<typeof orderSubscriptionSchema>[] => {
  const found = new Map<string, z.infer<typeof orderSubscriptionSchema>>();
  const visit = (value: unknown, inheritedStatus: string | null) => {
    const row = asRow(value);
    const status = asText(row.status) ?? inheritedStatus;
    const ids = [row.id, row.subscription_id]
      .concat(Array.isArray(row.subscription_ids) ? row.subscription_ids : [])
      .filter((id): id is string => typeof id === "string" && id.length <= 400);
    for (const id of ids) {
      const match = ORDER_SUBSCRIPTION_ID.exec(id.trim().toLowerCase());
      if (match?.[1] && match[2] && !found.has(match[0])) {
        found.set(match[0], {
          domain: match[2],
          kind: match[3] ? "inboxes" : "domain",
          orderId: match[1],
          status,
        });
      }
    }
    if (Array.isArray(row.subscriptions)) {
      for (const nested of row.subscriptions) {
        visit(nested, status);
      }
    }
  };
  const root = asRow(data);
  for (const key of ["subscriptions", "products", "purchases"] as const) {
    const list = root[key];
    if (Array.isArray(list)) {
      for (const entry of list) {
        visit(entry, null);
      }
    }
  }
  return [...found.values()];
};

const toSubscriptionSummary = (row: Record<string, unknown>) => ({
  cancelAtPeriodEnd:
    typeof row.cancel_at_period_end === "boolean"
      ? row.cancel_at_period_end
      : null,
  currentPeriodEnd: asUnixIso(row.current_period_end),
  id: asText(row.id) ?? "",
  status: asText(row.status),
  trialEnd: asUnixIso(row.trial_end),
});

const toDiscountSummary = (
  discount: unknown
): z.infer<typeof discountSummarySchema> | null => {
  const { coupon } = asRow(discount);
  if (coupon === null || typeof coupon !== "object") {
    return null;
  }
  const row = asRow(coupon);
  return {
    amountOffCents: asNumber(row.amount_off),
    couponId: asText(row.id),
    name: asText(row.name),
    percentOff: asNumber(row.percent_off),
    valid: typeof row.valid === "boolean" ? row.valid : null,
  };
};

/** `stripe_id` is the one Autumn field this tool trusts; everything else stays a passthrough. */
const readAutumnStripeId = (data: unknown): string | null => {
  const value = asRow(data).stripe_id;
  return typeof value === "string" && STRIPE_CUSTOMER_ID.test(value)
    ? value
    : null;
};

/** Injectable so the reconciliation can be tested without a live Autumn, Stripe or PlanetScale call. */
export interface WidgetBillingSummaryDeps {
  getAutumnCustomer: (customerId: string) => Promise<unknown>;
  getBillingAccount: (organizationId: string) => Promise<BillingAccountResult>;
  getCreditHistory?: (
    organizationId: string,
    window: CreditHistoryWindow
  ) => Promise<CreditHistoryResult>;
  getStripeCustomerBilling: (customerId: string) => Promise<StripeBilling>;
  /**
   * Whether the asking user is a live owner or admin of this organization, read
   * from production. It takes the same id the billing read takes, so the check
   * and the read cannot be pointed at different workspaces.
   */
  isAuthorized: (organizationId: string) => Promise<boolean>;
}

const EMPTY_SUMMARY: Omit<WidgetBillingSummary, "available" | "unavailable"> = {
  autumn: { available: false },
  creditHistory: null,
  credits: null,
  discount: null,
  failedPayments: [],
  orderSubscriptions: { available: false, items: [], truncated: false },
  organization: null,
  plan: null,
  recentCharges: [],
  recentInvoices: [],
  recentRefunds: [],
  reconciliation: { chargedButNoActiveSubscription: false, notes: [] },
  stripeSubscriptions: [],
  truncated: [],
};

interface AutumnResolution {
  available: boolean;
  data?: unknown;
  reason?: string;
  /** True when Autumn was never called on purpose (partner-governed or no billing account id), not because a call failed. */
  skipped: boolean;
}

/** Autumn is skipped, not failed, when there is structurally no Acquisity-native customer to read. */
async function resolveAutumn(
  account: BillingAccountResult,
  deps: WidgetBillingSummaryDeps
): Promise<AutumnResolution> {
  if (account.organization?.partnerGoverned) {
    return {
      available: false,
      reason:
        "Organization is governed by a non-Acquisity partner; no native Autumn customer exists.",
      skipped: true,
    };
  }
  const customerId = account.billingAccount?.id;
  if (!customerId) {
    return {
      available: false,
      reason:
        "No billing_account_id on this organization to look up in Autumn.",
      skipped: true,
    };
  }
  try {
    return {
      available: true,
      data: await deps.getAutumnCustomer(customerId),
      skipped: false,
    };
  } catch {
    return {
      available: false,
      reason: "Autumn read could not run.",
      skipped: false,
    };
  }
}

interface StripeResolution {
  noteEntries: string[];
  stripe: StripeBilling | null;
  unavailableEntries: string[];
}

/** Reads a Stripe customer's bounded bundle whenever Autumn handed back a stripe_id. */
async function resolveStripe(
  autumn: AutumnResolution,
  deps: WidgetBillingSummaryDeps
): Promise<StripeResolution> {
  const stripeCustomerId = readAutumnStripeId(autumn.data);
  if (!stripeCustomerId) {
    const reason = autumn.available
      ? "Autumn record has no stripe_id."
      : "No Stripe customer id available; Autumn was unavailable.";
    return autumn.skipped
      ? {
          noteEntries: [`Stripe was not checked: ${reason}`],
          stripe: null,
          unavailableEntries: [],
        }
      : {
          noteEntries: [],
          stripe: null,
          unavailableEntries: [`stripe: ${reason}`],
        };
  }
  try {
    const stripe = await deps.getStripeCustomerBilling(stripeCustomerId);
    const unavailableEntries = Object.entries(stripe)
      .filter(([, section]) => section.error)
      .map(([name]) => `stripe.${name} read failed`);
    return { noteEntries: [], stripe, unavailableEntries };
  } catch {
    return {
      noteEntries: [],
      stripe: null,
      unavailableEntries: ["stripe read could not run."],
    };
  }
}

/** True when a Stripe charge succeeded but the database shows no live subscription: charged without being provisioned. */
function chargedWithoutActiveSubscription(
  charges: ChargeSummary[],
  planStatus: string | null | undefined
): boolean {
  const hasSucceededCharge = charges.some(
    (charge) => charge.status === "succeeded"
  );
  const hasActiveSubscription = planStatus
    ? ACTIVE_SUBSCRIPTION_STATUSES.has(planStatus)
    : false;
  return hasSucceededCharge && !hasActiveSubscription;
}

/**
 * Reconciles one widget organization's billing across the product database
 * (plan, wallet totals, org/partner state), Autumn (credits and subscription,
 * kept as a bounded passthrough since Acquisity's Autumn schema is not typed
 * here) and Stripe (charges, invoices, refunds, discount). Every section
 * reports its own availability so a provider outage never reads as "no
 * charges" or "no plan".
 */
export async function composeWidgetBillingSummary(
  organizationId: string,
  deps: WidgetBillingSummaryDeps,
  input: WidgetBillingSummaryInput = {}
): Promise<WidgetBillingSummary> {
  const { creditWindow } = widgetBillingSummaryInputSchema.parse(input);
  const unavailable: string[] = [];
  // Every other widget tool hangs its reads off a live membership check. The
  // billing reads are keyed by organization id alone, so the check runs first,
  // and a check that fails or cannot run reads nothing.
  if (!(await deps.isAuthorized(organizationId).catch(() => false))) {
    unavailable.push("workspace could not be verified");
    return { ...EMPTY_SUMMARY, available: false, unavailable };
  }
  const account = await deps.getBillingAccount(organizationId);
  if (account.error) {
    unavailable.push("productDb read failed");
  }
  unavailable.push(...account.unavailable.map((entry) => `productDb.${entry}`));

  if (!(account.found && account.organization)) {
    unavailable.push("productDb: organization not found");
    return { ...EMPTY_SUMMARY, available: false, unavailable };
  }

  const notes: string[] = [];
  let creditHistory: CreditHistoryResult | null = null;
  if (creditWindow) {
    creditHistory = (await deps
      .getCreditHistory?.(organizationId, creditWindow)
      .catch(() => undefined)) ?? {
      available: false,
      completedManualGrants: [],
      transactionTotals: [],
      truncated: false,
      window: creditWindow,
    };
    if (!creditHistory.available) {
      unavailable.push("productDb.creditHistory read unavailable");
    }
    notes.push(
      "Credit-window totals cover this workspace's stored ledger only, not lifetime balances or all provider activity. Transaction amounts are signed. Manual grants may also appear in transactions; do not add the two sources. Manual grants without a completed_at timestamp are not included."
    );
  }
  const autumn = await resolveAutumn(account, deps);
  if (autumn.reason) {
    notes.push(...(autumn.skipped ? [autumn.reason] : []));
    unavailable.push(...(autumn.skipped ? [] : [`autumn: ${autumn.reason}`]));
  }

  const stripeResolution = await resolveStripe(autumn, deps);
  notes.push(...stripeResolution.noteEntries);
  unavailable.push(...stripeResolution.unavailableEntries);
  const { stripe } = stripeResolution;

  const charges = stripeListRows(stripe?.charges).map(toChargeSummary);
  const invoices = stripeListRows(stripe?.invoices).map(toInvoiceSummary);
  const subscriptions = stripeListRows(stripe?.subscriptions).map(
    toSubscriptionSummary
  );
  const failedPayments = charges.filter((charge) => charge.status === "failed");
  const recentRefunds = charges.filter(
    (charge) => charge.refunded || (charge.amountRefundedCents ?? 0) > 0
  );
  const truncated = (["charges", "invoices", "subscriptions"] as const)
    .filter((name) => stripeListHasMore(stripe?.[name]))
    .map((name) => `stripe.${name}: older rows exist beyond the ones shown`);
  const orderSubscriptions = autumn.available
    ? toOrderSubscriptions(autumn.data)
    : [];
  const discount = toDiscountSummary(asRow(stripe?.customer?.data).discount);

  const dbWallet = account.billingAccount;
  const plan = dbWallet
    ? {
        name: dbWallet.subscriptionPlan,
        provider: dbWallet.provider,
        status: dbWallet.subscriptionStatus,
      }
    : null;
  const credits = dbWallet
    ? {
        ...dbWallet.credits,
        // Stripe lists every status, newest first: a canceled subscription never renews.
        renewsAt:
          subscriptions.find(
            (sub) =>
              sub.status !== null &&
              ACTIVE_SUBSCRIPTION_STATUSES.has(sub.status)
          )?.currentPeriodEnd ?? null,
      }
    : null;

  const chargedButNoActiveSubscription = chargedWithoutActiveSubscription(
    charges,
    plan?.status
  );
  if (chargedButNoActiveSubscription) {
    notes.push(
      "Stripe shows a succeeded charge, but the product database has no active subscription status. Check whether this organization was charged without being provisioned."
    );
  }

  return {
    autumn: {
      available: autumn.available,
      ...(autumn.available ? { data: autumn.data } : {}),
      ...(autumn.reason ? { reason: autumn.reason } : {}),
    },
    available: true,
    creditHistory,
    credits,
    discount,
    failedPayments,
    orderSubscriptions: {
      available: autumn.available,
      items: orderSubscriptions.slice(0, MAX_ORDER_SUBSCRIPTIONS),
      truncated: orderSubscriptions.length > MAX_ORDER_SUBSCRIPTIONS,
    },
    organization: {
      id: account.organization.id,
      name: account.organization.name,
      partnerGoverned: account.organization.partnerGoverned,
    },
    plan,
    recentCharges: charges,
    recentInvoices: invoices,
    recentRefunds,
    reconciliation: { chargedButNoActiveSubscription, notes },
    stripeSubscriptions: subscriptions,
    truncated,
    unavailable,
  };
}

/** The same live owner/admin membership check the other widget tools read through. */
export function buildBillingAuthorizationQuery(context: WidgetContext): string {
  const scope = widgetContextSchema.parse(context);
  return `with authorized as (
    select o.id from organization o join member m on m.organization_id = o.id
    where o.id = '${scope.organizationId}'::uuid and m.user_id = '${scope.userId}'::uuid
      and o.deleted_at is null and m.deleted_at is null and m.role in ('owner', 'admin')
      and (o.partner_id is null or o.partner_id = '${scope.partnerId}'::uuid)
  )
  select (select count(*) = 1 from authorized) as authorized`;
}

const tool = defineTool({
  approval: (ctx) =>
    isWidgetSupport(ctx.session.auth.initiator)
      ? "not-applicable"
      : { reason: "Support widget investigations only.", type: "denied" },
  description:
    "Read a reconciled billing summary for this chat's verified organization: plan, credit balance with best-known renewal date, subscription status, recent Stripe charges and invoices with their line items (what each invoice billed for, with quantities), failed payments, recent refunds, and promo or coupon state. Plan and wallet totals come from the product database, credits and subscription detail come from Autumn (its raw customer record is included for cross-check since its schema is not typed here), and charges, invoices, refunds and discount come from Stripe. For dated credit questions, supply creditWindow (up to 93 days) to retrieve full-window workspace ledger totals by resource/type and completed manual-grant totals. These are separate from current/lifetime balances, can overlap each other, and do not establish complete provider usage. Always reads the verified widget organization; it never accepts a customer id or organization id as input. An invoice is evidence only for the products its own lines name. Each invoice reports `settlement`: a paid invoice that collected no money is not proof that anything was bought, and `customerBalanceAppliedCents` and `discountCents` show credit or discount where Stripe reports them. `orderSubscriptions` lists the billing subscriptions Acquisity created for a specific inbox or domain order; no source here links an order to the invoice or charge that paid for it, so say the attribution is unknown instead of matching by date, amount or paidAt. `truncated` names lists with older rows not shown. A missing section is unavailable, not zero: check `unavailable` and each section's own `available` flag before concluding there were no charges or no plan.",
  execute(input: WidgetBillingSummaryInput, ctx: ToolContext) {
    const scope = widgetContext(ctx.session.auth.initiator);
    if (!scope) {
      throw new Error("Support widget identity required.");
    }
    return composeWidgetBillingSummary(
      scope.organizationId,
      {
        getAutumnCustomer: (customerId) =>
          readAutumnCustomer(customerId, {
            client: executorClient(ctx),
            signal: ctx.abortSignal,
          }),
        getBillingAccount: (organizationId) =>
          readBillingAccount(organizationId, (query) =>
            callPlanetscaleReadQuery(ctx, {
              ...PRODUCTION_READ_QUERY_ARGS,
              query,
            })
          ),
        getCreditHistory: (organizationId, window) =>
          readBillingCreditHistory(organizationId, window, (query) =>
            callPlanetscaleReadQuery(ctx, {
              ...PRODUCTION_READ_QUERY_ARGS,
              query,
            })
          ),
        getStripeCustomerBilling: (customerId) =>
          readStripeCustomerBilling(customerId, {
            client: executorClient(ctx),
            signal: ctx.abortSignal,
          }),
        isAuthorized: async (organizationId) => {
          const [row] = parseReadQueryResult(
            await callPlanetscaleReadQuery(ctx, {
              ...PRODUCTION_READ_QUERY_ARGS,
              query: buildBillingAuthorizationQuery({
                ...scope,
                organizationId,
              }),
            })
          ).rows as { authorized?: unknown }[];
          return row?.authorized === true;
        },
      },
      input
    );
  },
  inputSchema: widgetBillingSummaryInputSchema,
  outputSchema: widgetBillingSummaryOutputSchema,
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) ? tool : null,
  },
});
