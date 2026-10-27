import { readAutumnCustomer } from "./billing-api.js";
import { executorClient } from "./executor/client.js";
import type { ProviderContext } from "./executor/dispatch.js";
import type { ProviderClient } from "./executor/operations.js";
import { ExecutorError } from "./executor/transport.js";
import { readInstantlySubworkspace } from "./instantly-api.js";
import { findRelatedIssues, linearGraphql } from "./linear-api.js";
import { PRODUCTION_READ_QUERY_ARGS } from "./lookup-customer.js";
import {
  callPlanetscaleReadQuery,
  parseReadQueryResult,
} from "./planetscale.js";
import {
  lookupIdentity,
  READ_BYTES,
  readDispute,
} from "./stripe-dispute-read.js";

/**
 * Every evidence source for one Stripe dispute, read in code in a fixed order
 * on every call (ENG-16494): Stripe, the database, Autumn, Instantly, Linear,
 * then the AI Acquisition client channel. A source that fails comes back
 * `{ checked: false, error }`, never dropped and never shown as empty, and
 * the facts the verdict rules decide on are computed here, not by the model.
 * Read only: no Slack join or post, no Linear mutation, no Stripe write.
 */

/** The whole call's cap; each provider keeps its own per-request deadline. */
export const GATHER_DEADLINE_MS = 180_000;
const DAY_MS = 86_400_000;
const HISTORY_DAYS = 14;
const USE_WINDOW_DAYS = 30;
const STRIPE_LIMIT = 50;
const MAX_CHANNEL_PAGES = 40;
const MAX_HISTORY_PAGES = 5;
const MAX_THREADS = 20;
const MAX_SLACK_USERS = 30;
const MAX_TICKETS = 25;
const TEXT_CHARS = 1500;
const DESCRIPTION_CHARS = 4000;
const ERROR_CHARS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const IDENTIFIER = /^([A-Z][A-Z0-9]*)-(\d+)$/u;
const PG_OFFSET = /([+-]\d\d)$/u;
const SLACK_USER = /^[UW][A-Z0-9]{2,30}$/u;
const ERRORING = /error|fail/iu;
const WITHDRAWN = /cancel|reject/iu;
/** Mailbox providers whose domain names no client. */
const FREE_MAIL = new Set([
  "aol",
  "gmail",
  "googlemail",
  "hotmail",
  "icloud",
  "live",
  "mac",
  "me",
  "msn",
  "outlook",
  "proton",
  "protonmail",
  "yahoo",
]);

export interface EvidenceDeps {
  /** Linear GraphQL reads. */
  readonly linear: ProviderClient;
  readonly now: () => number;
  /** Shared-toolkit reads: Stripe, Autumn, and Instantly. */
  readonly read: ProviderClient;
  /** AI Acquisition client Slack reads. */
  readonly slack: ProviderClient;
  /** One production PlanetScale read; returns the tool's text. */
  readonly sql: (query: string) => Promise<string>;
}

/** Rows kept and whether a row limit or byte cap cut the list. */
export interface RowList<T = Record<string, unknown>> {
  rows: T[];
  truncated: boolean;
}

export type Source<T> =
  | { checked: true; facts: T }
  | { checked: false; error: string };

/** One fact a verdict flag rests on, with where and when it came from. */
export interface Fact {
  date: string | null;
  detail: string;
  source: string;
}

/** True, false, or null when the facts that decide it could not be read. */
export interface Flag {
  because: Fact[];
  unknown?: string;
  value: boolean | null;
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj =>
  value !== null && typeof value === "object" ? (value as Obj) : {};
const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const idOf = (value: unknown): string | null =>
  str(value) ?? str(obj(value).id);
const fromSeconds = (value: unknown): string | null => {
  const seconds = num(value);
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
};
/** Milliseconds for an ISO or Postgres timestamp, or null. */
const ms = (value: unknown): number | null => {
  const text = str(value);
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text.replace(" ", "T").replace(PG_OFFSET, "$1:00"));
  return Number.isNaN(parsed) ? null : parsed;
};
const clip = (value: unknown, chars: number): string | null => {
  const text = typeof value === "string" ? value : null;
  return text && text.length > chars ? `${text.slice(0, chars)}...` : text;
};
const rowList = <T>(rows: T[], limit: number, cut = false): RowList<T> => ({
  rows: rows.slice(0, limit),
  truncated: cut || rows.length > limit,
});

const failure = (error: unknown): string => {
  if (error instanceof ExecutorError) {
    return `Executor could not complete the call (${error.code}).`;
  }
  return (
    error instanceof Error ? error.message : "The read could not run."
  ).slice(0, ERROR_CHARS);
};

const attempt = async <T>(read: () => Promise<T>): Promise<Source<T>> => {
  try {
    return { checked: true, facts: await read() };
  } catch (error) {
    return { checked: false, error: failure(error) };
  }
};

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
          subscription: idOf(line.subscription),
        };
      }
    ),
    paymentIntent: idOf(invoice.payment_intent),
    status: str(invoice.status),
    subscription: idOf(invoice.subscription) ?? idOf(parent.subscription),
  };
};
type InvoiceFacts = ReturnType<typeof invoiceFacts>;

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
type ChargeFacts = ReturnType<typeof chargeFacts>;

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
  activity: 100,
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
  const since = sqlLiteral(
    new Date(Date.parse(chargeDate) - USE_WINDOW_DAYS * DAY_MS).toISOString()
  );
  const members = `(select user_id from member where organization_id = ${org})`;
  const limit = (table: Table) => `limit ${ROW_LIMITS[table] + 1}`;
  return {
    activity: `select user_id, activity_type, activity_date, ip_address from user_activity where user_id in ${members} and activity_date >= ${since} order by activity_date desc ${limit("activity")}`,
    campaignMetrics: `select campaign_id, date::text as date, emails_sent from outreach_campaign_metrics where organization_id = ${org} and date::text >= ${sqlLiteral(new Date(Date.parse(chargeDate) - USE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10))} order by date::text desc ${limit("campaignMetrics")}`,
    campaigns: `select name, status, created_at from outreach_campaign where organization_id = ${org} order by created_at desc ${limit("campaigns")}`,
    deletionRequests: `select organization_id, status, completed_at, created_at from workspace_deletion_request where organization_id = ${org} order by created_at desc ${limit("deletionRequests")}`,
    domainCancellations: `select domain, billing_status, billing_cancelled_at, created_at from mail_domain_cancellation where organization_id = ${org} order by created_at desc ${limit("domainCancellations")}`,
    domains: `select domain, status, order_id, provisioned_at, expires_at, error, updated_at from mail_domain where organization_id = ${org} order by provisioned_at ${limit("domains")}`,
    endWarnings: `select domain_ends_at, status, sent_at from mail_domain_end_warning where organization_id = ${org} order by sent_at desc ${limit("endWarnings")}`,
    inboxes: `select domain_id, order_id, email, status, connected, connection_error, created_at, last_retry_at from mail_inbox where organization_id = ${org} order by created_at ${limit("inboxes")}`,
    members: `select m.user_id, m.role, m.created_at, m.deleted_at, u.email, u.name, u.created_at as user_created_at, u.last_login from member m join "user" u on u.id = m.user_id where m.organization_id = ${org} order by m.created_at ${limit("members")}`,
    orders: `select id, organization_id, billing_account_id, status, domain_count, inbox_count_per_domain, created_at, paid_at, completed_at from domain_purchase_order where billing_account_id = ${account} order by created_at desc ${limit("orders")}`,
    organizations: `select id, name, billing_account_id, created_at, deleted_at from organization where billing_account_id = ${account} order by created_at ${limit("organizations")}`,
    providers: `select provider, workspace_id, workspace_name, is_active from outreach_provider where organization_id = ${org} ${limit("providers")}`,
    renewalReminders: `select status, kind, created_at from cmr_renewal_reminder where organization_id = ${org} order by created_at desc ${limit("renewalReminders")}`,
    sessions: `select user_id, ip_address, user_agent, created_at, active_organization_id from session where user_id in ${members} order by created_at ${limit("sessions")}`,
    subscriptionCancellations: `select domain, status, completed_at, domain_purchase_order_id, created_at from cmr_subscription_cancellation where workspace_id = ${org} order by created_at desc ${limit("subscriptionCancellations")}`,
    supportChats: `select id as conversation_id, status, created_at, last_message_at from chat_conversation where organization_id = ${org} and kind = 'support' order by created_at desc ${limit("supportChats")}`,
    supportMessages: `select conversation_id, role, left(parts::text, ${TEXT_CHARS}) as parts, created_at from chat_message where organization_id = ${org} and conversation_id in (select id from chat_conversation where organization_id = ${org} and kind = 'support') order by created_at desc ${limit("supportMessages")}`,
    transitions: `select product_id, kind, scenario, occurred_at from autumn_product_transition where billing_account_id = ${account} order by occurred_at desc ${limit("transitions")}`,
  };
};

/** The workspace this charge's items went to, and how that was decided. */
export interface ProvisionedWorkspace {
  name: string | null;
  orderId: string | null;
  organizationId: string;
  via: "domain_purchase_order" | "only_workspace";
}

/**
 * Prefers the latest domain order on this billing account paid by the day
 * after the charge; otherwise the account's only workspace. Never a workspace
 * outside this billing account.
 */
export const provisionedWorkspace = (
  organizations: Obj[],
  orders: Obj[],
  chargeMs: number
): ProvisionedWorkspace | null => {
  const names = new Map(
    organizations.map((org) => [str(org.id), str(org.name)] as const)
  );
  const order = orders
    .filter((row) => names.has(str(row.organization_id)))
    .map((row) => ({ at: ms(row.paid_at) ?? ms(row.created_at), row }))
    .filter(
      (entry): entry is { at: number; row: Obj } =>
        entry.at !== null && entry.at <= chargeMs + DAY_MS
    )
    .sort((a, b) => b.at - a.at)[0]?.row;
  const orderOrg = order ? str(order.organization_id) : null;
  if (order && orderOrg) {
    return {
      name: names.get(orderOrg) ?? null,
      orderId: str(order.id),
      organizationId: orderOrg,
      via: "domain_purchase_order",
    };
  }
  const [only] = organizations;
  const onlyId = only ? str(only.id) : null;
  return organizations.length === 1 && only && onlyId
    ? {
        name: str(only.name),
        orderId: null,
        organizationId: onlyId,
        via: "only_workspace",
      }
    : null;
};

const sqlRows = async (deps: EvidenceDeps, query: string, limit: number) => {
  const { passthrough, rows } = parseReadQueryResult(await deps.sql(query));
  return rowList(rows.map(obj), limit, passthrough.truncated === true);
};

const readDatabase = async (
  deps: EvidenceDeps,
  stripe: Source<StripeFacts>
) => {
  if (!stripe.checked) {
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
  const chargeMs = Date.parse(chargeDate);
  // The workspace id is not known yet; the two account queries ignore it.
  const accountQueries = evidenceQueries(billingAccountId, "", chargeDate);
  // Sequential on purpose: concurrent reads drew a 422 (billing-account.ts).
  const organizations = await sqlRows(
    deps,
    accountQueries.organizations,
    ROW_LIMITS.organizations
  );
  const unavailable: string[] = [];
  const read = async (table: Table, query: string) => {
    try {
      return await sqlRows(deps, query, ROW_LIMITS[table]);
    } catch (error) {
      unavailable.push(`${table}: ${failure(error)}`);
      return null;
    }
  };
  const orders = await read("orders", accountQueries.orders);
  const provisioned = provisionedWorkspace(
    organizations.rows,
    orders?.rows ?? [],
    chargeMs
  );
  const tables: Partial<
    Record<Exclude<Table, "organizations" | "orders">, RowList | null>
  > = {};
  if (provisioned) {
    const queries = evidenceQueries(
      billingAccountId,
      provisioned.organizationId,
      chargeDate
    );
    for (const table of Object.keys(queries) as Table[]) {
      if (table !== "organizations" && table !== "orders") {
        // biome-ignore lint/performance/noAwaitInLoops: PlanetScale reads run one at a time.
        tables[table] = await read(table, queries[table]);
      }
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
  const id = stripe.checked ? stripe.facts.customer?.autumnId : null;
  if (!(id && UUID.test(id))) {
    throw new Error(
      "There is no billing account id from Stripe, so there is no Autumn customer to read."
    );
  }
  const customer = obj(await readAutumnCustomer(id, { client: deps.read }));
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
  if (!database.checked) {
    throw new Error(
      "The database read failed, so the workspace's Instantly subworkspace is unknown."
    );
  }
  const { providers } = database.facts;
  if (!database.facts.provisioned) {
    return { note: "No workspace was tied to this charge.", workspace: null };
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
    return {
      note: "The workspace has no Instantly subworkspace.",
      workspace: null,
    };
  }
  const page = async (resource: "accounts" | "campaigns") => {
    const result = await readInstantlySubworkspace(
      { id: workspaceId },
      resource,
      { limit: 100 },
      { client: deps.read }
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
  const campaigns = await page("campaigns");
  const accounts = await page("accounts");
  return {
    accounts: accounts.list,
    campaigns: campaigns.list,
    workspace: campaigns.workspace,
  };
};

// --- Linear --------------------------------------------------------------------

interface IssueBodiesData {
  issues: {
    nodes: {
      comments: {
        nodes: {
          body: string;
          createdAt: string;
          user: { name: string } | null;
        }[];
      };
      createdAt: string;
      description: string | null;
      identifier: string;
      state: { name: string };
      title: string;
      url: string;
    }[];
  };
}

const readLinear = async (
  deps: EvidenceDeps,
  stripe: Source<StripeFacts>,
  database: Source<DatabaseFacts>
) => {
  const phrases = [
    ...new Set(
      [
        stripe.checked ? stripe.facts.customer?.email : null,
        stripe.checked ? stripe.facts.cardholder.email : null,
        database.checked ? database.facts.provisioned?.name : null,
      ]
        .map((phrase) => phrase?.trim().toLowerCase())
        .filter((phrase): phrase is string => Boolean(phrase))
    ),
  ];
  if (phrases.length === 0) {
    throw new Error(
      "No customer email or workspace name was read, so Linear could not be searched."
    );
  }
  const related = await findRelatedIssues(
    { phrases, scope: "duplicates", windowed: false },
    { client: deps.linear }
  );
  const found = related.issues.slice(0, MAX_TICKETS);
  const keys = found.flatMap((issue) => {
    const match = IDENTIFIER.exec(issue.identifier);
    return match
      ? [{ number: { eq: Number(match[2]) }, team: { key: { eq: match[1] } } }]
      : [];
  });
  const bodies = keys.length
    ? (
        await linearGraphql<IssueBodiesData>(
          "IssueBodies",
          { filter: { or: keys } },
          { client: deps.linear }
        )
      ).issues.nodes
    : [];
  const byIdentifier = new Map(bodies.map((body) => [body.identifier, body]));
  return {
    phrases,
    tickets: rowList(
      found.map((issue) => {
        const body = byIdentifier.get(issue.identifier);
        return {
          comments: (body?.comments.nodes ?? [])
            .map((comment) => ({
              author: comment.user?.name ?? null,
              body: clip(comment.body, TEXT_CHARS),
              createdAt: comment.createdAt,
            }))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
          createdAt: issue.createdAt,
          description: clip(body?.description ?? null, DESCRIPTION_CHARS),
          identifier: issue.identifier,
          matchedPhrases: issue.matchedPhrases,
          state: issue.state,
          title: issue.title,
          url: issue.url,
        };
      }),
      MAX_TICKETS,
      related.truncated || related.issues.length > MAX_TICKETS
    ),
  };
};

// --- AI Acquisition client channel -----------------------------------------------

/** One Slack read; Slack answers HTTP 200 with `ok: false` on errors. */
const slackCall = async (
  deps: EvidenceDeps,
  request: Parameters<ProviderClient>[0]
): Promise<Obj> => {
  const response = await deps.slack(request);
  const data = obj(response.data);
  if (response.status !== 200 || data.ok !== true) {
    throw new Error(
      `Slack ${request.operation.slice(10)} failed (${str(data.error) ?? `HTTP ${response.status}`}).`
    );
  }
  return data;
};

/** Lowercase letters and digits joined by hyphens, as Slack names channels. */
const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");

/** The terms a client channel name is matched on: workspace name and email domain. */
export const channelTerms = (
  workspaceName: string | null,
  emails: (string | null)[]
): string[] => {
  const terms = new Set<string>();
  const name = workspaceName ? slug(workspaceName) : "";
  if (name.length >= 3) {
    terms.add(name);
  }
  for (const email of emails) {
    const label = email?.split("@")[1]?.toLowerCase().split(".")[0];
    if (label && label.length >= 3 && !FREE_MAIL.has(label)) {
      terms.add(slug(label));
    }
  }
  return [...terms];
};

const messageFacts = (message: Obj) => ({
  replyCount: num(message.reply_count) ?? 0,
  text: clip(message.text, TEXT_CHARS),
  threadTs: str(message.thread_ts),
  time: (() => {
    const ts = Number(str(message.ts));
    return Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null;
  })(),
  ts: str(message.ts),
  user: str(message.user) ?? str(message.bot_id),
});

type SlackMessage = ReturnType<typeof messageFacts>;

/** Every page of private channels, matched by name; null when the list was cut off. */
const matchChannels = async (deps: EvidenceDeps, terms: string[]) => {
  const matches: { id: string; name: string }[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    // biome-ignore lint/performance/noAwaitInLoops: cursors are sequential.
    const data = await slackCall(deps, {
      input: {
        limit: 200,
        types: "private_channel",
        ...(cursor ? { cursor } : {}),
      },
      operation: "slack.aia.channels",
    });
    for (const raw of (data.channels as unknown[] | undefined) ?? []) {
      const channel = obj(raw);
      const id = str(channel.id);
      const name = str(channel.name);
      if (id && name && terms.some((term) => slug(name).includes(term))) {
        matches.push({ id, name });
      }
    }
    cursor = str(obj(data.response_metadata).next_cursor) ?? undefined;
    pages += 1;
  } while (cursor && pages < MAX_CHANNEL_PAGES);
  return { complete: !cursor, matches };
};

/** The channel's messages since `oldest`, then the replies in its threads. */
const readChannel = async (
  deps: EvidenceDeps,
  channel: string,
  oldest: number
) => {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    // biome-ignore lint/performance/noAwaitInLoops: cursors are sequential.
    const data = await slackCall(deps, {
      input: {
        channel,
        latest: String(deps.now() / 1000),
        limit: 200,
        oldest: oldest.toFixed(6),
        ...(cursor ? { cursor } : {}),
      },
      operation: "slack.aia.history",
    });
    messages.push(
      ...((data.messages as unknown[] | undefined) ?? []).map((raw) =>
        messageFacts(obj(raw))
      )
    );
    cursor = str(obj(data.response_metadata).next_cursor) ?? undefined;
    pages += 1;
  } while (cursor && pages < MAX_HISTORY_PAGES);
  const threads = messages.filter((message) => message.replyCount > 0);
  const replies: SlackMessage[] = [];
  for (const parent of threads.slice(0, MAX_THREADS)) {
    if (!parent.ts) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: one Slack read at a time.
    const data = await slackCall(deps, {
      input: { channel, limit: 200, ts: parent.ts },
      operation: "slack.aia.replies",
    });
    replies.push(
      ...((data.messages as unknown[] | undefined) ?? [])
        .map((raw) => messageFacts(obj(raw)))
        .filter((reply) => reply.ts !== parent.ts)
    );
  }
  return {
    cut: Boolean(cursor) || threads.length > MAX_THREADS,
    messages: [...messages, ...replies].sort((a, b) =>
      (a.ts ?? "").localeCompare(b.ts ?? "")
    ),
  };
};

/** Display names for message authors; a failed lookup leaves the name null. */
const authorNames = async (deps: EvidenceDeps, messages: SlackMessage[]) => {
  const names = new Map<string, string | null>();
  const unavailable: string[] = [];
  const users = [
    ...new Set(
      messages
        .map((message) => message.user)
        .filter((user): user is string => SLACK_USER.test(user ?? ""))
    ),
  ];
  for (const user of users.slice(0, MAX_SLACK_USERS)) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one Slack read at a time.
      const data = await slackCall(deps, {
        input: { user },
        operation: "slack.aia.user",
      });
      const profile = obj(data.user);
      names.set(
        user,
        str(obj(profile.profile).real_name) ??
          str(profile.real_name) ??
          str(profile.name)
      );
    } catch (error) {
      unavailable.push(`user ${user}: ${failure(error)}`);
    }
  }
  return { cut: users.length > MAX_SLACK_USERS, names, unavailable };
};

const readSlack = async (
  deps: EvidenceDeps,
  stripe: Source<StripeFacts>,
  database: Source<DatabaseFacts>
) => {
  const terms = channelTerms(
    database.checked ? (database.facts.provisioned?.name ?? null) : null,
    stripe.checked
      ? [stripe.facts.customer?.email ?? null, stripe.facts.cardholder.email]
      : []
  );
  const chargeDate = stripe.checked ? stripe.facts.charge.created : null;
  if (terms.length === 0 || !chargeDate) {
    throw new Error(
      "No workspace name, company email domain, or charge date was read, so the client channel could not be matched."
    );
  }
  const { complete, matches } = await matchChannels(deps, terms);
  // Several matches would read another client's channel; pick one only when
  // every term narrows it to one.
  const narrowed =
    matches.length > 1
      ? matches.filter((match) =>
          terms.every((term) => slug(match.name).includes(term))
        )
      : matches;
  if (matches.length > 1 && narrowed.length !== 1) {
    throw new Error(
      `${matches.length} client channels match this customer, so none was read.`
    );
  }
  const [channel] = narrowed;
  if (!channel) {
    if (!complete) {
      throw new Error(
        `The channel list stopped after ${MAX_CHANNEL_PAGES} pages without a match.`
      );
    }
    return { channel: null, messages: rowList([], 0), terms };
  }
  const oldest = (Date.parse(chargeDate) - HISTORY_DAYS * DAY_MS) / 1000;
  const read = await readChannel(deps, channel.id, oldest);
  const authors = await authorNames(deps, read.messages);
  return {
    channel: { id: channel.id, name: channel.name },
    from: new Date(oldest * 1000).toISOString(),
    messages: rowList(
      read.messages.map((message) => ({
        ...message,
        author: message.user ? (authors.names.get(message.user) ?? null) : null,
      })),
      read.messages.length,
      read.cut || authors.cut
    ),
    terms,
    unavailable: authors.unavailable,
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

const unknown = (reason: string): Flag => ({
  because: [],
  unknown: reason,
  value: null,
});

/** True on proof, false only when every input that could prove it was read. */
const flag = (because: Fact[], missing: string | null): Flag => {
  if (because.length) {
    return { because, value: true };
  }
  return missing ? unknown(missing) : { because: [], value: false };
};

const refundedInFull = (stripe: StripeFacts): Flag => {
  const { amount, amountRefunded, refunds } = stripe.charge;
  if (amount === null) {
    return unknown("Stripe reported no charge amount.");
  }
  const because = refunds.map((refund) => ({
    date: refund.created,
    detail: `Refund ${refund.id ?? ""} of ${refund.amount ?? "?"} (${refund.status ?? "unknown status"}).`,
    source: "stripe.charges.refunds",
  }));
  return {
    because,
    value: amount > 0 && amountRefunded >= amount,
  };
};

const invoiceOf = (
  charge: Pick<ChargeFacts, "id" | "invoice" | "paymentIntent">,
  invoices: InvoiceFacts[]
): InvoiceFacts | undefined =>
  invoices.find(
    (invoice) =>
      (charge.invoice && invoice.id === charge.invoice) ||
      (charge.id && invoice.charge === charge.id) ||
      (charge.paymentIntent && invoice.paymentIntent === charge.paymentIntent)
  );

/** What one invoice billed: each priced line and its subscription for its period. */
const billedKeys = (invoice: InvoiceFacts): Set<string> =>
  new Set(
    invoice.lines.flatMap((line) => {
      const period = `${line.periodStart}|${line.periodEnd}`;
      const subscription = line.subscription ?? invoice.subscription;
      return [
        ...(line.price ? [`price:${line.price}|${period}`] : []),
        ...(subscription ? [`subscription:${subscription}|${period}`] : []),
      ];
    })
  );

const duplicate = (stripe: StripeFacts): Flag => {
  if (!(stripe.charges && stripe.invoices)) {
    return unknown(
      "The customer's Stripe charges or invoices could not be read."
    );
  }
  const disputed = invoiceOf(stripe.charge, stripe.invoices.rows);
  if (!disputed) {
    return stripe.charge.invoice && stripe.invoices.truncated
      ? unknown(
          "The disputed charge's invoice is past the invoice list's limit."
        )
      : { because: [], value: false };
  }
  const keys = billedKeys(disputed);
  const because = stripe.charges.rows.flatMap((other) => {
    if (
      other.id === stripe.charge.id ||
      other.status !== "succeeded" ||
      other.amount === null ||
      other.amountRefunded >= other.amount
    ) {
      return [];
    }
    const invoice = invoiceOf(other, stripe.invoices?.rows ?? []);
    if (!invoice || invoice.id === disputed.id) {
      return [];
    }
    const shared = [...billedKeys(invoice)].filter((key) => keys.has(key));
    return shared.length
      ? [
          {
            date: other.created,
            detail: `Charge ${other.id} of ${other.amount} on invoice ${invoice.id} bills the same ${shared[0]?.split(":")[0]} for the same period and is not refunded.`,
            source: "stripe.charges",
          },
        ]
      : [];
  });
  return { because, value: because.length > 0 };
};

const before = (value: unknown, chargeMs: number) => {
  const at = ms(value);
  return at !== null && at < chargeMs;
};

/** Domains expired or suspended, inboxes failing, or deletion asked for, before the charge. */
const stoppedInDatabase = (database: DatabaseFacts, chargeMs: number) => {
  const because: Fact[] = [];
  for (const row of database.domains?.rows ?? []) {
    const status = str(row.status)?.toLowerCase();
    const date = [row.expires_at, row.updated_at].find((value) =>
      before(value, chargeMs)
    );
    if ((status === "expired" || status === "suspended") && date) {
      because.push({
        date: str(date),
        detail: `Domain ${str(row.domain)} was ${status}.`,
        source: "database.mail_domain",
      });
    }
  }
  for (const row of database.inboxes?.rows ?? []) {
    const erroring =
      ERRORING.test(str(row.status) ?? "") ||
      Boolean(str(row.connection_error));
    if (erroring && before(row.last_retry_at, chargeMs)) {
      because.push({
        date: str(row.last_retry_at),
        detail: `Inbox ${str(row.email)} was failing (${str(row.status)}).`,
        source: "database.mail_inbox",
      });
    }
  }
  for (const row of database.deletionRequests?.rows ?? []) {
    if (
      !WITHDRAWN.test(str(row.status) ?? "") &&
      before(row.created_at, chargeMs)
    ) {
      because.push({
        date: str(row.created_at),
        detail: `Workspace deletion was requested (${str(row.status)}).`,
        source: "database.workspace_deletion_request",
      });
    }
  }
  return because;
};

const deliveryStoppedBeforeCharge = (
  stripe: StripeFacts,
  database: Source<DatabaseFacts>,
  chargeMs: number
): Flag => {
  const because: Fact[] = [];
  const subscription = invoiceOf(
    stripe.charge,
    stripe.invoices?.rows ?? []
  )?.subscription;
  const canceled = stripe.subscriptions?.rows.find(
    (row) => row.id === subscription && before(row.canceledAt, chargeMs)
  );
  if (canceled) {
    because.push({
      date: canceled.canceledAt,
      detail: `Subscription ${canceled.id} was canceled or set to cancel before the charge.`,
      source: "stripe.subscriptions",
    });
  }
  if (!database.checked) {
    return flag(because, "The database read failed.");
  }
  because.push(...stoppedInDatabase(database.facts, chargeMs));
  const { domains, inboxes, deletionRequests, provisioned } = database.facts;
  const missing = provisioned
    ? (
        [
          ["mail_domain", domains],
          ["mail_inbox", inboxes],
          ["workspace_deletion_request", deletionRequests],
        ] as const
      )
        .filter(([, list]) => !list)
        .map(([name]) => name)
    : ["the provisioned workspace"];
  const stripeMissing =
    stripe.charge.invoice && !(stripe.invoices && stripe.subscriptions)
      ? ["Stripe subscriptions"]
      : [];
  const gaps = [...missing, ...stripeMissing];
  return flag(
    because,
    gaps.length ? `Could not read ${gaps.join(", ")}.` : null
  );
};

const usedAfterCharge = (database: DatabaseFacts, chargeMs: number): Flag => {
  const after = (value: unknown) => {
    const at = ms(value);
    return at !== null && at > chargeMs;
  };
  const chargeDay = new Date(chargeMs).toISOString().slice(0, 10);
  const because: Fact[] = [];
  const latest = database.activity?.rows.find((row) =>
    after(row.activity_date)
  );
  if (latest) {
    because.push({
      date: str(latest.activity_date),
      detail: `Sign-in activity (${str(latest.activity_type)}) from ${str(latest.ip_address) ?? "an unknown address"}.`,
      source: "database.user_activity",
    });
  }
  for (const row of database.members?.rows ?? []) {
    if (after(row.last_login)) {
      because.push({
        date: str(row.last_login),
        detail: `${str(row.email)} last signed in.`,
        source: 'database."user".last_login',
      });
    }
  }
  const sends = (database.campaignMetrics?.rows ?? []).filter(
    (row) =>
      (str(row.date)?.slice(0, 10) ?? "") > chargeDay &&
      Number(row.emails_sent) > 0
  );
  if (sends.length) {
    because.push({
      date: str(sends[0]?.date),
      detail: `${sends.reduce((sum, row) => sum + Number(row.emails_sent), 0)} emails sent across ${sends.length} campaign days after the charge.`,
      source: "database.outreach_campaign_metrics",
    });
  }
  for (const [table, column, label] of [
    ["domains", "provisioned_at", "Domain"],
    ["inboxes", "created_at", "Inbox"],
  ] as const) {
    const row = database[table]?.rows.find((entry) => after(entry[column]));
    if (row) {
      because.push({
        date: str(row[column]),
        detail: `${label} ${str(row.domain) ?? str(row.email)} provisioned after the charge.`,
        source: `database.${table === "domains" ? "mail_domain" : "mail_inbox"}`,
      });
    }
  }
  const missing = (
    [
      ["user_activity", database.activity],
      ["member", database.members],
      ["outreach_campaign_metrics", database.campaignMetrics],
      ["mail_domain", database.domains],
      ["mail_inbox", database.inboxes],
    ] as const
  )
    .filter(([, list]) => !list)
    .map(([name]) => name);
  return flag(
    because,
    missing.length ? `Could not read ${missing.join(", ")}.` : null
  );
};

/** The rule facts, computed from what the sources returned. */
export const verdictFacts = (sources: EvidenceSources) => {
  const { stripe, database } = sources;
  if (!stripe.checked) {
    const none = unknown("The Stripe read failed.");
    return {
      chargeDate: null,
      deliveryStoppedBeforeCharge: none,
      duplicate: none,
      refundedInFull: none,
      tiedToWorkspace: none,
      usedAfterCharge: none,
    };
  }
  const chargeDate = stripe.facts.charge.created;
  const chargeMs = chargeDate ? Date.parse(chargeDate) : Number.NaN;
  const dated = !Number.isNaN(chargeMs);
  let tiedToWorkspace: Flag;
  let used: Flag;
  const autumnId = stripe.facts.customer?.autumnId;
  if (!stripe.facts.customer) {
    tiedToWorkspace = stripe.facts.unavailable.length
      ? unknown("The Stripe customer could not be read.")
      : {
          because: [
            {
              date: chargeDate,
              detail: "The charge has no Stripe customer.",
              source: "stripe.charges",
            },
          ],
          value: false,
        };
    used = unknown("No workspace is tied to the charge.");
  } else if (!(autumnId && UUID.test(autumnId))) {
    tiedToWorkspace = {
      because: [
        {
          date: null,
          detail: "The Stripe customer carries no billing account id.",
          source: "stripe.customers.metadata.autumn_id",
        },
      ],
      value: false,
    };
    used = unknown("No workspace is tied to the charge.");
  } else if (!database.checked) {
    tiedToWorkspace = unknown("The database read failed.");
    used = unknown("The database read failed.");
  } else if (database.facts.provisioned) {
    const { provisioned } = database.facts;
    tiedToWorkspace = {
      because: [
        {
          date: null,
          detail: `Workspace ${provisioned.name ?? provisioned.organizationId} is on the Stripe customer's billing account (${provisioned.via === "domain_purchase_order" ? `domain order ${provisioned.orderId}` : "its only workspace"}).`,
          source:
            provisioned.via === "domain_purchase_order"
              ? "database.domain_purchase_order"
              : "database.organization",
        },
      ],
      value: true,
    };
    used = dated
      ? usedAfterCharge(database.facts, chargeMs)
      : unknown("Stripe reported no charge date.");
  } else if (database.facts.organizations.rows.length === 0) {
    tiedToWorkspace = {
      because: [
        {
          date: null,
          detail: "No workspace uses the Stripe customer's billing account.",
          source: "database.organization",
        },
      ],
      value: false,
    };
    used = unknown("No workspace is tied to the charge.");
  } else {
    const reason = `The billing account covers ${database.facts.organizations.rows.length} workspaces and no domain order names the one this charge provisioned.`;
    tiedToWorkspace = unknown(reason);
    used = unknown(reason);
  }
  return {
    chargeDate,
    deliveryStoppedBeforeCharge: dated
      ? deliveryStoppedBeforeCharge(stripe.facts, database, chargeMs)
      : unknown("Stripe reported no charge date."),
    duplicate: duplicate(stripe.facts),
    refundedInFull: refundedInFull(stripe.facts),
    tiedToWorkspace,
    usedAfterCharge: used,
  };
};

// --- Bounds and entry points -----------------------------------------------------

const isRowList = (value: unknown): value is RowList =>
  value !== null &&
  typeof value === "object" &&
  Array.isArray((value as RowList).rows) &&
  typeof (value as RowList).truncated === "boolean";

const rowLists = (value: unknown, found: RowList[] = []): RowList[] => {
  if (isRowList(value)) {
    found.push(value);
  } else if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      rowLists(child, found);
    }
  }
  return found;
};

const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

/** Halves the largest row list until the whole result fits `cap`, flagging each cut. */
export const fitResponse = <T>(result: T, cap: number = READ_BYTES): T => {
  const lists = rowLists(result);
  while (bytes(result) > cap) {
    const [largest] = lists
      .filter((list) => list.rows.length > 0)
      .sort((a, b) => bytes(b.rows) - bytes(a.rows));
    if (!largest) {
      break;
    }
    largest.rows = largest.rows.slice(0, Math.floor(largest.rows.length / 2));
    largest.truncated = true;
  }
  return result;
};

/**
 * Reads every source, in order, even after one fails, then computes the rule
 * facts. Never throws for a source failure.
 */
export const gatherDisputeEvidence = async (
  disputeId: string,
  deps: EvidenceDeps
) => {
  const stripe = await attempt(() => readStripe(deps, disputeId));
  const database = await attempt(() => readDatabase(deps, stripe));
  const autumn = await attempt(() => readAutumn(deps, stripe));
  const instantly = await attempt(() => readInstantly(deps, database));
  const linear = await attempt(() => readLinear(deps, stripe, database));
  const slack = await attempt(() => readSlack(deps, stripe, database));
  const sources: EvidenceSources = {
    autumn,
    database,
    instantly,
    linear,
    slack,
    stripe,
  };
  return fitResponse({
    readAt: new Date(deps.now()).toISOString(),
    sources,
    verdict: verdictFacts(sources),
  });
};
export type DisputeEvidence = Awaited<ReturnType<typeof gatherDisputeEvidence>>;

/**
 * Production deps from a provider context alone, so a script can replay the
 * gather without a model: `{ abortSignal, getToken }` is enough. Every read
 * shares one whole-call deadline beside each provider's own.
 */
export const evidenceDeps = (ctx: ProviderContext): EvidenceDeps => {
  const scoped: ProviderContext = {
    abortSignal: AbortSignal.any([
      ctx.abortSignal,
      AbortSignal.timeout(GATHER_DEADLINE_MS),
    ]),
    getToken: (definition) => ctx.getToken(definition),
    ...(ctx.session ? { session: ctx.session } : {}),
  };
  const client = executorClient(scoped);
  const capped: ProviderClient = (request, options) =>
    client(request, { maxBytes: READ_BYTES, ...options });
  return {
    linear: client,
    now: Date.now,
    read: capped,
    slack: capped,
    sql: (query) =>
      callPlanetscaleReadQuery(scoped, {
        ...PRODUCTION_READ_QUERY_ARGS,
        query,
      }),
  };
};
