import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import {
  type BillingAccountResult,
  readBillingAccount,
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

const invoiceSummarySchema = z.object({
  amountDueCents: z.number().nullable(),
  amountPaidCents: z.number().nullable(),
  createdAt: z.string().nullable(),
  currency: z.string().nullable(),
  id: z.string(),
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

export const widgetBillingSummaryInputSchema = z.strictObject({});
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
  credits: walletSchema.extend({ renewsAt: z.string().nullable() }).nullable(),
  discount: discountSummarySchema.nullable(),
  failedPayments: z.array(chargeSummarySchema),
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

const toInvoiceSummary = (row: Record<string, unknown>) => ({
  amountDueCents: asNumber(row.amount_due),
  amountPaidCents: asNumber(row.amount_paid),
  createdAt: asUnixIso(row.created),
  currency: asText(row.currency),
  id: asText(row.id) ?? "",
  status: asText(row.status),
});

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
  getStripeCustomerBilling: (customerId: string) => Promise<StripeBilling>;
  /** Whether the asking user is a live owner or admin of the organization, read from production. */
  isAuthorized: () => Promise<boolean>;
}

const EMPTY_SUMMARY: Omit<WidgetBillingSummary, "available" | "unavailable"> = {
  autumn: { available: false },
  credits: null,
  discount: null,
  failedPayments: [],
  organization: null,
  plan: null,
  recentCharges: [],
  recentInvoices: [],
  recentRefunds: [],
  reconciliation: { chargedButNoActiveSubscription: false, notes: [] },
  stripeSubscriptions: [],
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
  deps: WidgetBillingSummaryDeps
): Promise<WidgetBillingSummary> {
  const unavailable: string[] = [];
  // Every other widget tool hangs its reads off a live membership check. The
  // billing reads are keyed by organization id alone, so the check runs first,
  // and a check that fails or cannot run reads nothing.
  if (!(await deps.isAuthorized().catch(() => false))) {
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
        renewsAt: subscriptions[0]?.currentPeriodEnd ?? null,
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
    credits,
    discount,
    failedPayments,
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
    "Read a reconciled billing summary for this chat's verified organization: plan, credit balance with best-known renewal date, subscription status, recent Stripe charges and invoices, failed payments, recent refunds, and promo or coupon state. Plan and wallet totals come from the product database, credits and subscription detail come from Autumn (its raw customer record is included for cross-check since its schema is not typed here), and charges, invoices, refunds and discount come from Stripe. Always reads the verified widget organization; it never accepts a customer id or organization id as input. A missing section is unavailable, not zero: check `unavailable` and each section's own `available` flag before concluding there were no charges or no plan.",
  execute(_input: WidgetBillingSummaryInput, ctx: ToolContext) {
    const scope = widgetContext(ctx.session.auth.initiator);
    if (!scope) {
      throw new Error("Support widget identity required.");
    }
    return composeWidgetBillingSummary(scope.organizationId, {
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
      getStripeCustomerBilling: (customerId) =>
        readStripeCustomerBilling(customerId, {
          client: executorClient(ctx),
          signal: ctx.abortSignal,
        }),
      isAuthorized: async () => {
        const [row] = parseReadQueryResult(
          await callPlanetscaleReadQuery(ctx, {
            ...PRODUCTION_READ_QUERY_ARGS,
            query: buildBillingAuthorizationQuery(scope),
          })
        ).rows as { authorized?: unknown }[];
        return row?.authorized === true;
      },
    });
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
