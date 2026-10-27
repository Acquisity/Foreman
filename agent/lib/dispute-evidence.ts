import { readAutumnCustomer } from "./billing-api.js";
import { withEvidenceDeadline } from "./dispute-evidence-deadline.js";
import {
  attempt,
  boundedText,
  clip,
  failure,
  num,
  type Obj,
  obj,
  type RowList,
  rowList,
  type Source,
  str,
  UUID,
} from "./dispute-evidence-shared.js";
import { readLinear } from "./dispute-linear.js";
import { readSlack } from "./dispute-slack.js";
import { verdictFacts } from "./dispute-verdict.js";
import { executorClient } from "./executor/client.js";
import type { ProviderContext } from "./executor/dispatch.js";
import type { ProviderClient } from "./executor/operations.js";
import { ExecutorError } from "./executor/transport.js";
import {
  readInstantlySubworkspace,
  resolveInstantlySubworkspace,
} from "./instantly-api.js";
import { PRODUCTION_READ_QUERY_ARGS } from "./lookup-customer.js";
import {
  callPlanetscaleReadQuery,
  parseReadQueryResult,
} from "./planetscale.js";
import {
  stripeDate as fromSeconds,
  stripeId as idOf,
  lookupIdentity,
  matchChargeInvoice,
  READ_BYTES,
  readDispute,
} from "./stripe-dispute-read.js";

/**
 * Every evidence source for one Stripe dispute, returned in a fixed order
 * on every call (ENG-16494): Stripe, the database, Autumn, Instantly, Linear,
 * then the AI Acquisition client channel. A source that fails comes back
 * `{ checked: false, error }`, never dropped and never shown as empty, and
 * the facts the verdict rules decide on are computed here, not by the model.
 * Read only: no Slack join or post, no Linear mutation, no Stripe write.
 */

/** The whole call's cap; each provider keeps its own per-request deadline. */
export const GATHER_DEADLINE_MS = 240_000;
export const SOURCE_DEADLINES_MS = {
  autumn: 25_000,
  database: 100_000,
  instantly: 120_000,
  linear: 45_000,
  slack: 90_000,
  stripe: 40_000,
} as const;
const DAY_MS = 86_400_000;
const USE_WINDOW_DAYS = 30;
const STRIPE_LIMIT = 50;
const TEXT_CHARS = 1500;
export interface EvidenceDeps {
  readonly abortSignal?: AbortSignal;
  /** Linear GraphQL reads. */
  readonly linear: ProviderClient;
  readonly now: () => number;
  /** Shared-toolkit reads: Stripe, Autumn, and Instantly. */
  readonly read: ProviderClient;
  /** AI Acquisition client Slack reads. */
  readonly slack: ProviderClient;
  /** One production PlanetScale read; returns the tool's text. */
  readonly sql: (query: string, signal?: AbortSignal) => Promise<string>;
}

// --- Stripe ------------------------------------------------------------------

const invoiceFacts = (invoice: Obj) => {
  const parent = obj(obj(invoice.parent).subscription_details);
  return {
    amountPaid: num(invoice.amount_paid),
    charge: idOf(invoice.charge),
    created: fromSeconds(invoice.created),
    id: str(invoice.id),
    lines: ((obj(invoice.lines).data as unknown[] | undefined) ?? []).map(
      (raw) => {
        const line = obj(raw);
        return {
          amount: num(line.amount),
          description: clip(line.description, 200),
          periodEnd: fromSeconds(obj(line.period).end),
          periodStart: fromSeconds(obj(line.period).start),
          price:
            idOf(line.price) ?? str(obj(obj(line.pricing).price_details).price),
          subscription:
            idOf(line.subscription) ??
            idOf(obj(obj(line.parent).subscription_item_details).subscription),
          subscriptionItem:
            idOf(line.subscription_item) ??
            idOf(
              obj(obj(line.parent).subscription_item_details).subscription_item
            ),
        };
      }
    ),
    linesTruncated: obj(invoice.lines).has_more === true,
    paidAt: fromSeconds(obj(invoice.status_transitions).paid_at),
    paymentIntent: idOf(invoice.payment_intent),
    status: str(invoice.status),
    subscription: idOf(invoice.subscription) ?? idOf(parent.subscription),
  };
};
export type InvoiceFacts = ReturnType<typeof invoiceFacts>;

const chargeFacts = (charge: Obj) => ({
  amount: num(charge.amount),
  amountRefunded: num(charge.amount_refunded) ?? 0,
  created: fromSeconds(charge.created),
  description: clip(charge.description, 200),
  disputed: charge.disputed === true,
  id: str(charge.id),
  invoice: idOf(charge.invoice),
  paymentIntent: idOf(charge.payment_intent),
  status: str(charge.status),
});
export type ChargeFacts = ReturnType<typeof chargeFacts>;

const subscriptionFacts = (subscription: Obj) => ({
  cancelAt: fromSeconds(subscription.cancel_at),
  cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
  canceledAt: fromSeconds(subscription.canceled_at),
  created: fromSeconds(subscription.created),
  endedAt: fromSeconds(subscription.ended_at),
  id: str(subscription.id),
  prices: ((obj(subscription.items).data as unknown[] | undefined) ?? []).map(
    (item) => idOf(obj(item).price)
  ),
  status: str(subscription.status),
});

const creditNoteFacts = (note: Obj) => ({
  amount: num(note.amount) ?? num(note.total),
  created: fromSeconds(note.created),
  id: str(note.id),
  invoice: idOf(note.invoice),
  reason: str(note.reason),
  status: str(note.status),
});

/** One Stripe list read: rows mapped, `has_more` reported as truncated. */
const stripeList = async <T>(
  deps: EvidenceDeps,
  request: Parameters<ProviderClient>[0],
  map: (row: Obj) => T
): Promise<RowList<T>> => {
  const response = await deps.read(request);
  if (response.status !== 200) {
    throw new Error(`Stripe list read failed with HTTP ${response.status}.`);
  }
  const data = obj(response.data);
  const rows = ((data.data as unknown[] | undefined) ?? []).map((row) =>
    map(obj(row))
  );
  return rowList(rows, STRIPE_LIMIT, data.has_more === true);
};

const readStripe = async (deps: EvidenceDeps, disputeId: string) => {
  const dispute = await readDispute(deps, disputeId);
  const chargeId = idOf(dispute.charge);
  const identity = await lookupIdentity(deps, chargeId);
  if ("error" in identity) {
    throw new Error(identity.error);
  }
  const customer =
    identity.customer && !("error" in identity.customer)
      ? identity.customer
      : null;
  const unavailable: string[] = [];
  if (identity.customer && "error" in identity.customer) {
    unavailable.push(`customer: ${identity.customer.error}`);
  }
  const list = async <T>(
    name: string,
    request: Parameters<ProviderClient>[0],
    map: (row: Obj) => T
  ): Promise<RowList<T> | null> => {
    try {
      return await stripeList(deps, request, map);
    } catch (error) {
      unavailable.push(`${name}: ${failure(error)}`);
      return null;
    }
  };
  const id = customer?.id;
  const invoices = id
    ? await list(
        "invoices",
        {
          input: { customer: id, limit: STRIPE_LIMIT },
          operation: "stripe.invoices.list",
        },
        invoiceFacts
      )
    : null;
  const chargedAt = identity.charge.created
    ? Date.parse(identity.charge.created) / 1000
    : Number.NaN;
  const invoiceWindow =
    id && Number.isFinite(chargedAt)
      ? await list(
          "invoiceWindow",
          {
            input: {
              "created[gte]": Math.floor(chargedAt - (2 * DAY_MS) / 1000),
              "created[lte]": Math.floor(chargedAt + (2 * DAY_MS) / 1000),
              customer: id,
              limit: STRIPE_LIMIT,
            },
            operation: "stripe.invoices.list",
          },
          invoiceFacts
        )
      : null;
  const subscriptions = id
    ? await list(
        "subscriptions",
        {
          input: { customer: id, limit: STRIPE_LIMIT, status: "all" },
          operation: "stripe.subscriptions.list",
        },
        subscriptionFacts
      )
    : null;
  const charges = id
    ? await list(
        "charges",
        {
          input: { customer: id, limit: STRIPE_LIMIT },
          operation: "stripe.charges.list",
        },
        chargeFacts
      )
    : null;
  const creditNotes = id
    ? await list(
        "creditNotes",
        {
          input: { customer: id, limit: STRIPE_LIMIT },
          operation: "stripe.credit_notes.list",
        },
        creditNoteFacts
      )
    : null;
  return {
    cardholder: identity.cardholder,
    charge: identity.charge,
    chargeInvoice: matchChargeInvoice(
      identity.charge,
      invoiceWindow?.rows ?? [],
      invoiceWindow !== null && !invoiceWindow.truncated
    ),
    charges,
    creditNotes,
    customer,
    dispute: {
      amount: dispute.amount ?? null,
      cardBrand: dispute.payment_method_details?.card?.brand ?? null,
      created: fromSeconds(dispute.created),
      currency: dispute.currency ?? null,
      dueBy: fromSeconds(dispute.evidence_details?.due_by),
      id: dispute.id,
      networkReasonCode:
        dispute.payment_method_details?.card?.network_reason_code ?? null,
      reason: dispute.reason ?? null,
      status: dispute.status,
      stripeLink: `https://dashboard.stripe.com/disputes/${dispute.id}`,
      submissionCount: dispute.evidence_details?.submission_count ?? null,
    },
    invoices,
    invoiceWindow,
    subscriptions,
    unavailable,
  };
};
export type StripeFacts = Awaited<ReturnType<typeof readStripe>>;

// --- Database ----------------------------------------------------------------

/** A SQL string literal: apostrophes doubled, as `lookup-customer.ts` does. */
export const sqlLiteral = (value: string): string =>
  `'${value.replace(/'/gu, "''")}'`;

const ROW_LIMITS = {
  campaignMetrics: 200,
  campaigns: 50,
  deletionRequests: 20,
  domainCancellations: 100,
  domains: 200,
  endWarnings: 50,
  inboxes: 200,
  members: 50,
  orders: 50,
  organizations: 20,
  providers: 10,
  renewalReminders: 50,
  sessions: 25,
  subscriptionCancellations: 50,
  supportChats: 20,
  supportMessages: 100,
  transitions: 50,
} as const;
type Table = keyof typeof ROW_LIMITS;

/**
 * The fixed queries. Named columns only: `session.token` is never selected.
 * Each asks for one row past its limit so a cut list is known, and every
 * per-workspace query is scoped to the one workspace the charge provisioned.
 */
export const evidenceQueries = (
  billingAccountId: string,
  organizationId: string,
  chargeDate: string
): Record<Table, string> => {
  const account = sqlLiteral(billingAccountId);
  const org = sqlLiteral(organizationId);
  const members = `(select user_id from member where organization_id = ${org})`;
  const limit = (table: Table) => `limit ${ROW_LIMITS[table] + 1}`;
  return {
    campaignMetrics: `select campaign_id, date::text as date, emails_sent from outreach_campaign_metrics where organization_id = ${org} and date::text >= ${sqlLiteral(new Date(Date.parse(chargeDate) - USE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10))} order by date::text desc ${limit("campaignMetrics")}`,
    campaigns: `select name, status, created_at from outreach_campaign where organization_id = ${org} order by created_at desc ${limit("campaigns")}`,
    deletionRequests: `select organization_id, status, completed_at, created_at from workspace_deletion_request where organization_id = ${org} order by created_at desc ${limit("deletionRequests")}`,
    domainCancellations: `select domain, billing_status, billing_cancelled_at, created_at from mail_domain_cancellation where organization_id = ${org} order by created_at desc ${limit("domainCancellations")}`,
    domains: `select domain, status, order_id, provisioned_at, expires_at, error, updated_at from mail_domain where organization_id = ${org} order by provisioned_at ${limit("domains")}`,
    endWarnings: `select domain_ends_at, status, sent_at from mail_domain_end_warning where organization_id = ${org} order by sent_at desc ${limit("endWarnings")}`,
    inboxes: `select domain_id, order_id, email, status, connected, connection_error, created_at, last_retry_at from mail_inbox where organization_id = ${org} order by created_at ${limit("inboxes")}`,
    members: `select m.user_id, m.role, m.created_at, m.deleted_at, u.email, u.name, u.created_at as user_created_at from member m join "user" u on u.id = m.user_id where m.organization_id = ${org} order by m.created_at ${limit("members")}`,
    orders: `select id, organization_id, billing_account_id, status, domain_count, inbox_count_per_domain, created_at, paid_at, completed_at from domain_purchase_order where billing_account_id = ${account} order by created_at desc ${limit("orders")}`,
    organizations: `select id, name, billing_account_id, created_at, deleted_at from organization where billing_account_id = ${account} order by created_at ${limit("organizations")}`,
    providers: `select provider, workspace_id, workspace_name, is_active from outreach_provider where organization_id = ${org} ${limit("providers")}`,
    renewalReminders: `select status, kind, created_at from cmr_renewal_reminder where organization_id = ${org} order by created_at desc ${limit("renewalReminders")}`,
    sessions: `select user_id, ip_address, user_agent, created_at, active_organization_id from session where active_organization_id = ${org} and user_id in ${members} order by created_at ${limit("sessions")}`,
    subscriptionCancellations: `select domain, status, completed_at, domain_purchase_order_id, created_at from cmr_subscription_cancellation where workspace_id = ${org} order by created_at desc ${limit("subscriptionCancellations")}`,
    supportChats: `select id as conversation_id, status, created_at, last_message_at from chat_conversation where organization_id = ${org} and kind = 'support' order by created_at desc ${limit("supportChats")}`,
    supportMessages: `select conversation_id, role, left(parts::text, ${TEXT_CHARS}) as parts, length(parts::text) > ${TEXT_CHARS} as text_truncated, created_at from chat_message where organization_id = ${org} and conversation_id in (select id from chat_conversation where organization_id = ${org} and kind = 'support') order by created_at desc ${limit("supportMessages")}`,
    transitions: `select product_id, kind, scenario, occurred_at from autumn_product_transition where billing_account_id = ${account} order by occurred_at desc ${limit("transitions")}`,
  };
};

/** The workspace this charge's items went to, and how that was decided. */
export interface ProvisionedWorkspace {
  name: string | null;
  organizationId: string;
  via: "only_workspace";
}

/** No observed Stripe metadata links a charge to an order or workspace. */
export const provisionedWorkspace = (
  organizations: RowList
): ProvisionedWorkspace | null => {
  const live = organizations.rows.filter((row) => !row.deleted_at);
  if (organizations.truncated || live.length !== 1) {
    return null;
  }
  const [organization] = live;
  const organizationId = str(organization.id);
  return organizationId
    ? { name: str(organization.name), organizationId, via: "only_workspace" }
    : null;
};

/** One result row carries named JSON arrays, so provider row limits cannot drop tables. */
export const combinedEvidenceQuery = (
  queries: Partial<Record<Table, string>>
): string =>
  `select ${Object.entries(queries)
    .map(
      ([table, query]) =>
        `(select coalesce(json_agg(evidence_rows), '[]'::json) from (${query}) evidence_rows) as "${table}"`
    )
    .join(",\n")}`;

const readTables = async (
  deps: EvidenceDeps,
  queries: Partial<Record<Table, string>>
) => {
  const query = combinedEvidenceQuery(queries);
  let text: string;
  try {
    text = await deps.sql(query);
  } catch (error) {
    const transient =
      error instanceof TypeError ||
      (error instanceof ExecutorError &&
        ((error.status !== undefined && error.status >= 500) ||
          (error.code === "execution_not_dispatched" &&
            error.cause instanceof TypeError)));
    if (!transient || deps.abortSignal?.aborted) {
      throw error;
    }
    text = await deps.sql(query);
  }
  const { rows, passthrough } = parseReadQueryResult(text);
  if (passthrough.truncated || rows.length !== 1) {
    throw new Error(
      "The combined database result is incomplete; expected one complete row."
    );
  }
  const result: Partial<Record<Table, RowList | null>> = {};
  const unavailable: string[] = [];
  for (const table of Object.keys(queries) as Table[]) {
    try {
      const raw = obj(rows[0])[table];
      const values: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!Array.isArray(values)) {
        throw new Error("The table result is not a complete JSON array.");
      }
      result[table] = rowList(
        values.map(obj),
        ROW_LIMITS[table],
        values.some((row) => obj(row).text_truncated === true)
      );
    } catch (error) {
      result[table] = null;
      unavailable.push(`${table}: ${failure(error)}`);
    }
  }
  return { tables: result, unavailable };
};

const readDatabase = async (
  deps: EvidenceDeps,
  stripe: Source<StripeFacts>
) => {
  if (!stripe.facts) {
    throw new Error(
      "The Stripe read failed, so there is no billing account to scope the database read."
    );
  }
  const billingAccountId = stripe.facts.customer?.autumnId ?? null;
  const chargeDate = stripe.facts.charge.created;
  if (!(billingAccountId && UUID.test(billingAccountId))) {
    throw new Error(
      `The Stripe customer carries ${billingAccountId ? "an Autumn id that is not a billing account id" : "no Autumn id"}, so no workspace can be read for this charge.`
    );
  }
  if (!chargeDate) {
    throw new Error("Stripe reported no charge date.");
  }
  // The workspace id is not known yet; the two account queries ignore it.
  const accountQueries = evidenceQueries(billingAccountId, "", chargeDate);
  // Two sequential round trips: account inventory, then the resolved workspace.
  const account = await readTables(deps, {
    orders: accountQueries.orders,
    organizations: accountQueries.organizations,
  });
  const { organizations } = account.tables;
  const orders = account.tables.orders ?? null;
  if (!organizations) {
    throw new Error(account.unavailable.join("; "));
  }
  const unavailable = [...account.unavailable];
  const provisioned = provisionedWorkspace(organizations);
  const tables: Partial<
    Record<Exclude<Table, "organizations" | "orders">, RowList | null>
  > = {};
  if (provisioned) {
    const queries = evidenceQueries(
      billingAccountId,
      provisioned.organizationId,
      chargeDate
    );
    const {
      organizations: _organizations,
      orders: _orders,
      ...workspaceQueries
    } = queries;
    try {
      const workspace = await readTables(deps, workspaceQueries);
      Object.assign(tables, workspace.tables);
      unavailable.push(...workspace.unavailable);
    } catch (error) {
      unavailable.push(
        `workspace tables (${Object.keys(workspaceQueries).join(", ")}): ${failure(error)}`
      );
    }
  }
  return {
    billingAccountId,
    orders,
    organizations,
    provisioned,
    ...tables,
    unavailable,
  };
};
export type DatabaseFacts = Awaited<ReturnType<typeof readDatabase>>;

// --- Autumn and Instantly ----------------------------------------------------

const readAutumn = async (deps: EvidenceDeps, stripe: Source<StripeFacts>) => {
  const id = stripe.facts ? stripe.facts.customer?.autumnId : null;
  if (!(id && UUID.test(id))) {
    throw new Error(
      "There is no billing account id from Stripe, so there is no Autumn customer to read."
    );
  }
  const customer = obj(
    await readAutumnCustomer(id, {
      client: deps.read,
      signal: deps.abortSignal,
    })
  );
  const list = (value: unknown) =>
    rowList((Array.isArray(value) ? value : []).map(obj), 20);
  return {
    id,
    purchases: list(customer.purchases),
    subscriptions: list(customer.subscriptions),
  };
};

const readInstantly = async (
  deps: EvidenceDeps,
  database: Source<DatabaseFacts>
) => {
  if (!database.facts) {
    throw new Error(
      "The database read failed, so the workspace's Instantly subworkspace is unknown."
    );
  }
  const { providers } = database.facts;
  if (!database.facts.provisioned) {
    throw new Error(
      "The charge could not be tied to a workspace, so its Instantly data is unverified."
    );
  }
  if (!providers) {
    throw new Error("The outreach_provider read failed.");
  }
  const provider = providers.rows.find(
    (row) =>
      str(row.provider)?.toLowerCase() === "instantly" && str(row.workspace_id)
  );
  const workspaceId = provider ? str(provider.workspace_id) : null;
  if (!workspaceId) {
    if (providers.truncated) {
      throw new Error("The outreach_provider list is incomplete.");
    }
    return {
      note: "The workspace has no Instantly subworkspace.",
      workspace: null,
    };
  }
  const resolved = await resolveInstantlySubworkspace(
    { id: workspaceId },
    { client: deps.read, signal: deps.abortSignal }
  );
  const page = async (resource: "accounts" | "campaigns") => {
    const result = await readInstantlySubworkspace(
      resolved,
      resource,
      { limit: 100 },
      { client: deps.read, signal: deps.abortSignal }
    );
    return {
      list: rowList(
        result.items.map(obj),
        100,
        result.nextStartingAfter !== null
      ),
      workspace: result.workspace,
    };
  };
  const unavailable: string[] = [];
  const read = async (resource: "accounts" | "campaigns") => {
    try {
      return await page(resource);
    } catch (error) {
      unavailable.push(`${resource}: ${failure(error)}`);
      return null;
    }
  };
  const campaigns = await read("campaigns");
  const accounts = await read("accounts");
  return {
    accounts: accounts?.list ?? null,
    campaigns: campaigns?.list ?? null,
    unavailable,
    workspace: campaigns?.workspace ?? accounts?.workspace ?? null,
  };
};

// --- Verdict facts -------------------------------------------------------------

export interface EvidenceSources {
  autumn: Source<Awaited<ReturnType<typeof readAutumn>>>;
  database: Source<DatabaseFacts>;
  instantly: Source<Awaited<ReturnType<typeof readInstantly>>>;
  linear: Source<Awaited<ReturnType<typeof readLinear>>>;
  slack: Source<Awaited<ReturnType<typeof readSlack>>>;
  stripe: Source<StripeFacts>;
}

// --- Bounds and entry points -----------------------------------------------------

interface EvidenceResult {
  error?: string;
  readAt: string;
  sources: EvidenceSources;
  textTruncated?: boolean;
  verdict: ReturnType<typeof verdictFacts>;
}

/** Measure the real tool envelope; an oversized result fails explicitly. */
export const fitResponse = (
  result: EvidenceResult,
  cap: number = READ_BYTES
): EvidenceResult => {
  const bounded = boundedText(result);
  const fitted = { ...bounded.value, textTruncated: bounded.clipped };
  if (
    Buffer.byteLength(JSON.stringify({ ok: true, result: fitted }), "utf8") <
    cap
  ) {
    return fitted;
  }
  const error =
    "The gathered evidence exceeds the response size limit; its facts could not be returned.";
  const failed = { checked: false as const, error };
  // biome-ignore assist/source/useSortedKeys: source output order is part of the evidence contract.
  const sources: EvidenceSources = {
    stripe: failed,
    database: failed,
    autumn: failed,
    instantly: failed,
    linear: failed,
    slack: failed,
  };
  return {
    error,
    readAt: result.readAt.slice(0, 40),
    sources,
    verdict: verdictFacts(sources),
  };
};

/** Reads Stripe first, then overlaps independent work without parallel SQL. */
export const gatherDisputeEvidence = (disputeId: string, deps: EvidenceDeps) =>
  withEvidenceDeadline(deps, GATHER_DEADLINE_MS, async (scoped) => {
    const source = <T>(
      name: keyof typeof SOURCE_DEADLINES_MS,
      read: (input: EvidenceDeps) => Promise<T>
    ) =>
      withEvidenceDeadline(scoped, SOURCE_DEADLINES_MS[name], (input) =>
        attempt(() => read(input))
      );
    const stripe = await source("stripe", (input) =>
      readStripe(input, disputeId)
    );
    // Autumn only needs Stripe identity; the remaining reads need workspace scope.
    const databaseRead = source("database", (input) =>
      readDatabase(input, stripe)
    );
    const autumnRead = source("autumn", (input) => readAutumn(input, stripe));
    const database = await databaseRead;
    const [autumn, instantly, linear, slack] = await Promise.all([
      autumnRead,
      source("instantly", (input) => readInstantly(input, database)),
      source("linear", (input) => readLinear(input, stripe, database)),
      source("slack", (input) => readSlack(input, stripe, database)),
    ]);
    // biome-ignore assist/source/useSortedKeys: source output order is part of the evidence contract.
    const sources: EvidenceSources = {
      stripe,
      database,
      autumn,
      instantly,
      linear,
      slack,
    };
    return fitResponse({
      readAt: new Date(deps.now()).toISOString(),
      sources,
      verdict: verdictFacts(sources),
    });
  });
export type DisputeEvidence = Awaited<ReturnType<typeof gatherDisputeEvidence>>;

/**
 * Production deps from a provider context alone, so a script can replay the
 * gather without a model: `{ abortSignal, getToken }` is enough. Every read
 * honors its source deadline and the whole-call backstop.
 */
export const evidenceDeps = (ctx: ProviderContext): EvidenceDeps => {
  const client = executorClient(ctx);
  const capped: ProviderClient = (request, options) =>
    client(request, { maxBytes: READ_BYTES, ...options });
  return {
    abortSignal: ctx.abortSignal,
    linear: client,
    now: Date.now,
    read: capped,
    slack: capped,
    sql: (query, signal) =>
      callPlanetscaleReadQuery(
        {
          abortSignal: signal ?? ctx.abortSignal,
          getToken: (definition) => ctx.getToken(definition),
          ...(ctx.session ? { session: ctx.session } : {}),
        },
        {
          ...PRODUCTION_READ_QUERY_ARGS,
          query,
        }
      ),
  };
};
