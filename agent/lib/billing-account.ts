import { z } from "zod";
import { parseReadQueryResult } from "./planetscale.js";

/** Organization ids are uuids in `packages/db` (`primaryId`). */
export const organizationIdSchema = z.string().trim().toLowerCase().uuid();

/** Rows per history list; hitting it sets the matching `truncated` flag. */
export const HISTORY_LIMIT = 20;

/**
 * Four fixed statements, named columns only, read from
 * `packages/db/src/schema/{organization,billing,credit,manual-credit}.ts`.
 * No card, token, or key column exists on these tables; none is selected.
 */
export const billingAccountQueries = (rawOrganizationId: string) => {
  // Re-checked here so no caller can hand the literals anything but a uuid.
  const organizationId = organizationIdSchema.parse(rawOrganizationId);
  return {
    balances: [
      "select balance, lifetime_purchased, lifetime_granted, lifetime_used, updated_at",
      "from credit_balance",
      `where organization_id = '${organizationId}'`,
    ].join("\n"),
    manualCredits: [
      "select credits_amount, target_wallet, reason, status, previous_balance, new_balance, failure_reason, created_at, completed_at",
      "from manual_credit",
      `where organization_id = '${organizationId}'`,
      "order by created_at desc",
      `limit ${HISTORY_LIMIT}`,
    ].join("\n"),
    organization: [
      "select o.id, o.name, o.partner_id, o.created_at, o.billing_account_id,",
      "       b.provider, b.subscription_status, b.subscription_plan, b.trial_ends_at, b.first_trial_observed_at, b.first_paid_observed_at,",
      "       b.credit_balance, b.lifetime_purchased, b.lifetime_granted, b.lifetime_used,",
      "       b.domain_balance, b.lifetime_domains_purchased, b.lifetime_domains_used,",
      "       b.inbox_balance, b.lifetime_inboxes_purchased, b.lifetime_inboxes_used,",
      "       b.website_credit_balance, b.lifetime_website_purchased, b.lifetime_website_granted, b.lifetime_website_used",
      "from organization o",
      "left join billing_account b on b.id = o.billing_account_id",
      `where o.id = '${organizationId}'`,
    ].join("\n"),
    transactions: [
      "select type, amount, balance_after, resource, description, reference_type, reference_id, created_at",
      "from credit_transaction",
      `where organization_id = '${organizationId}'`,
      "order by created_at desc",
      `limit ${HISTORY_LIMIT}`,
    ].join("\n"),
  };
};

const text = z.union([z.string(), z.number()]).transform(String);
const num = z.union([z.number(), z.string()]).transform(Number);
const organizationRow = z.looseObject({
  billing_account_id: text.nullish(),
  created_at: text.nullish(),
  credit_balance: num.nullish(),
  domain_balance: num.nullish(),
  first_paid_observed_at: text.nullish(),
  first_trial_observed_at: text.nullish(),
  id: text,
  inbox_balance: num.nullish(),
  lifetime_domains_purchased: num.nullish(),
  lifetime_domains_used: num.nullish(),
  lifetime_granted: num.nullish(),
  lifetime_inboxes_purchased: num.nullish(),
  lifetime_inboxes_used: num.nullish(),
  lifetime_purchased: num.nullish(),
  lifetime_used: num.nullish(),
  lifetime_website_granted: num.nullish(),
  lifetime_website_purchased: num.nullish(),
  lifetime_website_used: num.nullish(),
  name: text.nullish(),
  partner_id: text.nullish(),
  provider: text.nullish(),
  subscription_plan: text.nullish(),
  subscription_status: text.nullish(),
  trial_ends_at: text.nullish(),
  website_credit_balance: num.nullish(),
});

const wallet = z.object({
  balance: z.number(),
  lifetimeGranted: z.number().nullable(),
  lifetimePurchased: z.number(),
  lifetimeUsed: z.number(),
});

export const billingAccountResultSchema = z.object({
  billingAccount: z
    .object({
      credits: wallet,
      domains: wallet,
      firstPaidObservedAt: z.string().nullable(),
      firstTrialObservedAt: z.string().nullable(),
      id: z.string(),
      inboxes: wallet,
      provider: z.string().nullable(),
      subscriptionPlan: z.string().nullable(),
      subscriptionStatus: z.string().nullable(),
      trialEndsAt: z.string().nullable(),
      websiteCredits: wallet,
    })
    .nullable(),
  creditBalances: z.array(z.record(z.string(), z.unknown())),
  error: z.string().optional(),
  found: z.boolean(),
  manualCredits: z.array(z.record(z.string(), z.unknown())),
  organization: z
    .object({
      createdAt: z.string().nullable(),
      id: z.string(),
      name: z.string().nullable(),
      /** Non-null means a partner governs billing; read it before routing on provider. */
      partnerId: z.string().nullable(),
    })
    .nullable(),
  transactions: z.array(z.record(z.string(), z.unknown())),
  truncated: z.object({
    manualCredits: z.boolean(),
    transactions: z.boolean(),
  }),
  /** Lists whose statement failed; their arrays are empty and unverified, not empty in production. */
  unavailable: z.array(z.string()),
});

export type BillingAccountResult = z.infer<typeof billingAccountResultSchema>;

const EMPTY: BillingAccountResult = {
  billingAccount: null,
  creditBalances: [],
  found: false,
  manualCredits: [],
  organization: null,
  transactions: [],
  truncated: { manualCredits: false, transactions: false },
  unavailable: [],
};

const rowsOf = async (run: (query: string) => Promise<string>, query: string) =>
  parseReadQueryResult(await run(query)).rows as Record<string, unknown>[];

/**
 * The PlanetScale system-of-record read for a billing ticket: the
 * organization with its partner, the billing account with plan state and
 * every wallet, the credit balance rows, and the last 20 credit transactions
 * and manual credits. Four statements, so one failing or long list never
 * blanks the others.
 */
export async function readBillingAccount(
  organizationId: string,
  run: (query: string) => Promise<string>
): Promise<BillingAccountResult> {
  const queries = billingAccountQueries(organizationId);
  try {
    const [orgResult, ...lists] = await Promise.allSettled([
      rowsOf(run, queries.organization),
      rowsOf(run, queries.balances),
      rowsOf(run, queries.transactions),
      rowsOf(run, queries.manualCredits),
    ]);
    if (orgResult.status === "rejected") {
      throw orgResult.reason;
    }
    const unavailable: string[] = [];
    const settled = (
      name: "creditBalances" | "transactions" | "manualCredits",
      result: PromiseSettledResult<Record<string, unknown>[]>
    ) => {
      if (result.status === "fulfilled") {
        return result.value;
      }
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      unavailable.push(`${name}: ${reason}`);
      return [];
    };
    const creditBalances = settled("creditBalances", lists[0]);
    const transactions = settled("transactions", lists[1]);
    const manualCredits = settled("manualCredits", lists[2]);
    const [first] = orgResult.value;
    if (!first) {
      return EMPTY;
    }
    const row = organizationRow.parse(first);
    const walletOf = (
      balance: number | null | undefined,
      purchased: number | null | undefined,
      granted: number | null | undefined,
      used: number | null | undefined
    ) => ({
      balance: balance ?? 0,
      lifetimeGranted: granted ?? null,
      lifetimePurchased: purchased ?? 0,
      lifetimeUsed: used ?? 0,
    });
    return {
      billingAccount: row.billing_account_id
        ? {
            credits: walletOf(
              row.credit_balance,
              row.lifetime_purchased,
              row.lifetime_granted,
              row.lifetime_used
            ),
            domains: walletOf(
              row.domain_balance,
              row.lifetime_domains_purchased,
              null,
              row.lifetime_domains_used
            ),
            firstPaidObservedAt: row.first_paid_observed_at ?? null,
            firstTrialObservedAt: row.first_trial_observed_at ?? null,
            id: row.billing_account_id,
            inboxes: walletOf(
              row.inbox_balance,
              row.lifetime_inboxes_purchased,
              null,
              row.lifetime_inboxes_used
            ),
            provider: row.provider ?? null,
            subscriptionPlan: row.subscription_plan ?? null,
            subscriptionStatus: row.subscription_status ?? null,
            trialEndsAt: row.trial_ends_at ?? null,
            websiteCredits: walletOf(
              row.website_credit_balance,
              row.lifetime_website_purchased,
              row.lifetime_website_granted,
              row.lifetime_website_used
            ),
          }
        : null,
      creditBalances,
      found: true,
      manualCredits,
      organization: {
        createdAt: row.created_at ?? null,
        id: row.id,
        name: row.name ?? null,
        partnerId: row.partner_id ?? null,
      },
      transactions,
      truncated: {
        manualCredits: manualCredits.length >= HISTORY_LIMIT,
        transactions: transactions.length >= HISTORY_LIMIT,
      },
      unavailable,
    };
  } catch (error) {
    return {
      ...EMPTY,
      error:
        error instanceof Error ? error.message : "Billing account read failed.",
    };
  }
}
