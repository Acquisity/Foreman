import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { operationPath } from "#lib/executor/bindings.js";
import { executorClient } from "#lib/executor/client.js";
import {
  invokeProvider,
  type ProviderContext,
} from "#lib/executor/dispatch.js";
import {
  InstantlyApiError,
  readInstantlySubworkspace,
} from "#lib/instantly-api.js";
import { PRODUCTION_READ_QUERY_ARGS } from "#lib/lookup-customer.js";
import { logOpsEvent } from "#lib/ops-log.js";
import { providerData } from "#lib/support/conversation.js";
import {
  isWidgetSupport,
  requireWidgetContext,
  type WidgetContext,
  widgetContextSchema,
} from "#lib/widget-scope.js";

/** Sending accounts fetched from Instantly for a stale-sync scan (Instantly's own page cap). */
const ACCOUNTS_LIMIT = 100;
/**
 * Pages followed before the counts are reported as a sample. Instantly hands back
 * a cursor well short of the page size, so a single page covered 12 and 15 accounts
 * of larger workspaces and was reported as "all healthy".
 */
const MAX_ACCOUNT_PAGES = 10;
/** Stale-sync accounts (recent activity, error status) surfaced in the result. */
const MISMATCH_LIMIT = 25;
/** Bounded diagnostic rows, with non-ready accounts first. */
const ACCOUNT_DETAIL_LIMIT = 200;
const RECENT_WEBHOOK_WINDOW_DAYS = 7;
/**
 * A sending account counts as "recently active" when Instantly last used it within this
 * window. ponytail: fixed 3-day window as a recency proxy for "actively sending"; make it
 * configurable if a shorter/longer campaign cadence produces false positives or negatives.
 */
const RECENT_ACTIVITY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** Acquisity's INITIAL_DFY_WARMUP_WINDOW_MS: a done-for-you inbox cannot send for its first 14 days. */
const INITIAL_WARMUP_DAYS = 14;
/** Done-for-you inboxes in initial warmup read from the product database. */
const INITIAL_WARMUP_LIMIT = 1000;

export const widgetInboxHealthInput = z.strictObject({});
export type WidgetInboxHealthInput = z.infer<typeof widgetInboxHealthInput>;

const timestamp = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));

const connection = z.object({
  accountType: z.enum(["user_owned", "system_provisioned"]),
  hasConnectionError: z.boolean(),
  isActive: z.boolean(),
  updatedAt: timestamp,
});
const webhook = z.object({
  lastEventAt: timestamp.nullable(),
  recentErrorCount: z.number().int().nonnegative(),
  recentEventCount: z.number().int().nonnegative(),
  registeredCount: z.number().int().nonnegative(),
});
const staleSyncAccount = z.object({
  email: z.string().max(320),
  lastUsedAt: timestamp.nullable(),
  status: z.number().nullable(),
});
const accountDetail = z.object({
  bucket: z.enum([
    "error",
    "initialWarmup",
    "paused",
    "ready",
    "setupPending",
    "unknown",
  ]),
  dailyLimit: z.number().nullable(),
  email: z.string().max(320).nullable(),
  errorCode: z.string().max(64).nullable(),
  lastUsedAt: timestamp.nullable(),
  setupPending: z.boolean().nullable(),
  slowRampEnabled: z.boolean().nullable(),
  status: z.number().nullable(),
  warmupScore: z.number().nullable(),
  warmupStartedAt: timestamp.nullable(),
  warmupStatus: z.number().nullable(),
});
const accounts = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    details: z.array(accountDetail).max(ACCOUNT_DETAIL_LIMIT),
    detailsTruncated: z.boolean(),
    error: z.number().int().nonnegative(),
    initialWarmup: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    setupPending: z.number().int().nonnegative(),
    staleSyncAccounts: z.array(staleSyncAccount).max(MISMATCH_LIMIT),
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
    unknown: z.number().int().nonnegative(),
  }),
  z.object({ available: z.literal(false), reason: z.string() }),
]);
export const widgetInboxHealthOutput = z.union([
  z.object({
    accounts,
    caveats: z.array(z.string()).max(6),
    connection: connection.nullable(),
    observedAt: timestamp,
    source: z.literal(
      "Acquisity product database, plus a live Instantly read for Acquisity-provisioned connections"
    ),
    status: z.literal("ok"),
    webhook: webhook.nullable(),
    workspace: z.string().max(500),
  }),
  z.object({ message: z.string(), status: z.enum(["unavailable", "denied"]) }),
]);
export type WidgetInboxHealthOutput = z.infer<typeof widgetInboxHealthOutput>;

/**
 * One fixed statement: this organization's saved Instantly connection, its registered
 * webhook count, and recent webhook event activity. No model input, no SQL, no workspace
 * selector - every join hangs off the authorized organization.
 */
export function buildWidgetInboxHealthQuery(context: WidgetContext): string {
  const scope = widgetContextSchema.parse(context);
  return `with authorized as (
    select o.id from organization o join member m on m.organization_id = o.id
    where o.id = '${scope.organizationId}'::uuid and m.user_id = '${scope.userId}'::uuid
      and o.deleted_at is null and m.deleted_at is null and m.role in ('owner', 'admin')
      and (o.partner_id is null or o.partner_id = '${scope.partnerId}'::uuid)
  ),
  provider as (
    select p.id, p.account_type, p.is_active, p.connection_error, p.workspace_id, p.updated_at
    from outreach_provider p join authorized a on a.id = p.organization_id
    where p.provider = 'instantly'
    limit 1
  )
  select
    (select count(*) = 1 from authorized) as authorized,
    current_timestamp as "observedAt",
    (select p.account_type from provider p) as "accountType",
    (select p.is_active from provider p) as "isActive",
    (select (nullif(p.connection_error, '') is not null) from provider p) as "hasConnectionError",
    (select p.workspace_id from provider p) as "workspaceId",
    (select p.updated_at from provider p) as "connectionUpdatedAt",
    (select count(*)::int from outreach_webhook w
      where w.provider_id = (select id from provider)) as "webhookRegisteredCount",
    (select max(e.created_at) from outreach_webhook_event e
      where e.provider_id = (select id from provider)) as "lastWebhookEventAt",
    (select count(*)::int from outreach_webhook_event e
      where e.provider_id = (select id from provider)
        and e.created_at > current_timestamp - interval '${RECENT_WEBHOOK_WINDOW_DAYS} days') as "recentWebhookEventCount",
    (select count(*)::int from outreach_webhook_event e
      where e.provider_id = (select id from provider)
        and e.created_at > current_timestamp - interval '${RECENT_WEBHOOK_WINDOW_DAYS} days'
        and e.outcome = 'error') as "recentWebhookErrorCount",
    (select coalesce(jsonb_agg(w.email), '[]'::jsonb) from (
      select lower(mi.email) as email from mail_inbox mi join authorized a on a.id = mi.organization_id
      where mi.mailbox_type = 'dfy'
        and mi.created_at > current_timestamp - interval '${INITIAL_WARMUP_DAYS} days'
      order by mi.created_at desc limit ${INITIAL_WARMUP_LIMIT + 1}) w) as "initialWarmupEmails"`;
}

const dbRow = z.object({
  accountType: z.enum(["user_owned", "system_provisioned"]).nullable(),
  authorized: z.boolean(),
  connectionUpdatedAt: timestamp.nullable(),
  hasConnectionError: z.boolean().nullable(),
  initialWarmupEmails: z
    .array(z.string().max(320))
    .max(INITIAL_WARMUP_LIMIT + 1),
  isActive: z.boolean().nullable(),
  lastWebhookEventAt: timestamp.nullable(),
  observedAt: timestamp,
  recentWebhookErrorCount: z.number().int().nonnegative(),
  recentWebhookEventCount: z.number().int().nonnegative(),
  webhookRegisteredCount: z.number().int().nonnegative(),
  workspaceId: z.string().min(1).max(200).nullable(),
});

/** Instantly's account item after the shared safe-field allowlist strips everything else. */
const instantlyAccount = z.object({
  daily_limit: z.number().nullish().catch(null),
  email: z.string().max(320).optional(),
  enable_slow_ramp: z.boolean().nullish().catch(null),
  setup_pending: z.boolean().nullish(),
  stat_warmup_score: z.number().nullish().catch(null),
  status: z.number().optional(),
  status_message_code: z.string().optional(),
  timestamp_last_used: z.string().nullish(),
  timestamp_warmup_start: timestamp.nullish().catch(null),
  warmup_status: z.number().nullish().catch(null),
});

const CAVEATS = [
  "Connection and webhook facts are saved product state, not a live provider check.",
  "A saved connection error does not establish a current failure by itself.",
  "Each account read lands in exactly one of ready, paused, setupPending, initialWarmup, error or unknown, using Acquisity's own rules. ready means Instantly reports it active, with no error, setup finished, and not a done-for-you inbox in its first 14 days; it does not prove mail is being delivered. paused is switched off, not broken. setupPending is not warmup. unknown means the evidence was missing or unrecognized: never describe it as healthy or as broken.",
  "The counts cover the accounts that were read. With accounts.truncated false that is every account. With truncated true it is a sample: say how many were checked, and never that all accounts are healthy or that nothing needs fixing.",
  "Account details come from the live Instantly read, except the initialWarmup bucket uses saved DFY creation dates. Non-ready accounts are listed first; detailsTruncated means some scanned accounts are omitted. dailyLimit is the provider account setting, not a campaign cap or measured sending rate; Acquisity manages these settings, so do not ask the customer to change them in Instantly.",
  "Live account status is only checked for Acquisity-provisioned connections; a user-managed Instantly workspace cannot be verified as belonging to this organization.",
];

type Bucket =
  | "error"
  | "initialWarmup"
  | "paused"
  | "ready"
  | "setupPending"
  | "unknown";

/**
 * Acquisity's rules, in its order: hasEmailAccountError, then setup_pending
 * (provider-inbox-readiness), then initial DFY warmup, then status 1 active / 2 paused.
 * warmupComplete false means the warmup list was cut off, so an active account that is
 * not on it cannot be confirmed ready.
 */
function classify(
  account: z.infer<typeof instantlyAccount>,
  warmupEmails: ReadonlySet<string>,
  warmupComplete: boolean
): Bucket {
  if (
    account.status_message_code ||
    (typeof account.status === "number" && account.status < 0)
  ) {
    return "error";
  }
  if (account.setup_pending === true) {
    return "setupPending";
  }
  const email = account.email?.trim().toLowerCase();
  if (email && warmupEmails.has(email)) {
    return "initialWarmup";
  }
  if (account.status === 2) {
    return "paused";
  }
  if (account.status === 1 && email && warmupComplete) {
    return "ready";
  }
  return "unknown";
}

function bucketAccounts(
  items: unknown[],
  initialWarmupEmails: string[]
): {
  buckets: Record<Bucket, number>;
  details: z.infer<typeof accountDetail>[];
  staleSyncAccounts: z.infer<typeof staleSyncAccount>[];
} {
  const buckets: Record<Bucket, number> = {
    error: 0,
    initialWarmup: 0,
    paused: 0,
    ready: 0,
    setupPending: 0,
    unknown: 0,
  };
  const warmupEmails = new Set(initialWarmupEmails);
  const warmupComplete = initialWarmupEmails.length <= INITIAL_WARMUP_LIMIT;
  const staleSyncAccounts: z.infer<typeof staleSyncAccount>[] = [];
  const details: z.infer<typeof accountDetail>[] = [];
  const now = Date.now();
  for (const raw of items) {
    const account = instantlyAccount.parse(raw);
    const bucket = classify(account, warmupEmails, warmupComplete);
    buckets[bucket] += 1;
    details.push({
      bucket,
      dailyLimit: account.daily_limit ?? null,
      email: account.email ?? null,
      errorCode: account.status_message_code ?? null,
      lastUsedAt: timestamp
        .nullable()
        .catch(null)
        .parse(account.timestamp_last_used),
      setupPending: account.setup_pending ?? null,
      slowRampEnabled: account.enable_slow_ramp ?? null,
      status: account.status ?? null,
      warmupScore: account.stat_warmup_score ?? null,
      warmupStartedAt: account.timestamp_warmup_start ?? null,
      warmupStatus: account.warmup_status ?? null,
    });
    const lastUsedAt = account.timestamp_last_used
      ? Date.parse(account.timestamp_last_used)
      : Number.NaN;
    const recentlyActive =
      Number.isFinite(lastUsedAt) &&
      now - lastUsedAt <= RECENT_ACTIVITY_WINDOW_MS;
    if (
      recentlyActive &&
      typeof account.status === "number" &&
      account.status < 0 &&
      staleSyncAccounts.length < MISMATCH_LIMIT
    ) {
      staleSyncAccounts.push({
        email: account.email ?? "unknown",
        lastUsedAt: account.timestamp_last_used ?? null,
        status: account.status,
      });
    }
  }
  details.sort(
    (a, b) => Number(a.bucket === "ready") - Number(b.bucket === "ready")
  );
  return {
    buckets,
    details: details.slice(0, ACCOUNT_DETAIL_LIMIT),
    staleSyncAccounts,
  };
}

/** Live Instantly account check, only for a workspace Acquisity itself provisioned. */
async function readAccountsEvidence(
  ctx: ProviderContext,
  row: z.infer<typeof dbRow>
): Promise<z.infer<typeof accounts>> {
  if (row.accountType === "user_owned") {
    return {
      available: false,
      reason:
        "This organization's Instantly workspace is user-managed, so Acquisity cannot verify it belongs to this organization; live inbox checks are limited to Acquisity-provisioned connections.",
    };
  }
  if (row.isActive === false) {
    return {
      available: false,
      reason: "This organization's Instantly connection is turned off.",
    };
  }
  if (!row.workspaceId) {
    return {
      available: false,
      reason: "No Instantly workspace is linked to this connection.",
    };
  }
  try {
    const items: unknown[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_ACCOUNT_PAGES; page += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each page needs the previous cursor.
      const read = await readInstantlySubworkspace(
        { id: row.workspaceId },
        "accounts",
        { limit: ACCOUNTS_LIMIT, startingAfter },
        { client: executorClient(ctx), signal: ctx.abortSignal }
      );
      items.push(...read.items);
      startingAfter = read.nextStartingAfter ?? undefined;
      if (!(startingAfter && read.items.length)) {
        startingAfter = undefined;
        break;
      }
    }
    const { buckets, details, staleSyncAccounts } = bucketAccounts(
      items,
      row.initialWarmupEmails
    );
    return {
      available: true,
      ...buckets,
      details,
      detailsTruncated: items.length > details.length,
      staleSyncAccounts,
      total: items.length,
      truncated: startingAfter !== undefined,
    };
  } catch (error) {
    if (ctx.abortSignal.aborted) {
      throw error;
    }
    logOpsEvent(
      "widget.support.inbox_health.instantly_failed",
      {
        code: "instantly",
        outcome: "error",
        tool: "widget_inbox_health",
      },
      console.warn
    );
    return {
      available: false,
      reason:
        error instanceof InstantlyApiError
          ? error.message
          : "Instantly could not be read.",
    };
  }
}

/** Widget reads accept no selector: this organization's own connection, always. */
export async function readWidgetInboxHealth(
  ctx: ProviderContext
): Promise<WidgetInboxHealthOutput> {
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  const query = buildWidgetInboxHealthQuery(scope);
  let stage = "configuration";
  let row: z.infer<typeof dbRow>;
  try {
    ctx.abortSignal.throwIfAborted();
    const path = operationPath("planetscale.readQuery");
    if (
      path !==
      "planetscale.org.foremanPlanetscale.planetscale_execute_read_query"
    ) {
      throw new Error("Unexpected evidence operation binding.");
    }
    stage = "transport";
    const result = await invokeProvider(
      ctx,
      path,
      { ...PRODUCTION_READ_QUERY_ARGS, query, use_replica: false },
      undefined,
      { maxBytes: 128 * 1024, timeoutMs: 50_000 }
    );
    if (!result.ok || (result.http && result.http.status !== 200)) {
      throw new Error("Evidence provider unavailable.");
    }
    stage = "response";
    const envelope = z
      .object({
        rows: z.array(dbRow).length(1),
        success: z.literal(true),
      })
      .parse(providerData(result.data));
    [row] = envelope.rows;
  } catch (error) {
    if (ctx.abortSignal.aborted) {
      throw error;
    }
    // Parser and provider errors may contain customer rows or credentials. Never forward them.
    logOpsEvent(
      "widget.support.inbox_health.failed",
      { code: stage, outcome: "error", tool: "widget_inbox_health" },
      console.warn
    );
    return {
      message:
        "Inbox connection state could not be checked. This is not an empty result.",
      status: "unavailable",
    };
  }
  if (!row.authorized) {
    return {
      message: "Current workspace access could not be verified.",
      status: "denied",
    };
  }
  if (row.accountType === null) {
    return widgetInboxHealthOutput.parse({
      accounts: {
        available: false,
        reason: "No Instantly connection is configured for this organization.",
      },
      caveats: CAVEATS,
      connection: null,
      observedAt: row.observedAt,
      source:
        "Acquisity product database, plus a live Instantly read for Acquisity-provisioned connections",
      status: "ok",
      webhook: null,
      workspace: scope.organizationName,
    });
  }
  return widgetInboxHealthOutput.parse({
    accounts: await readAccountsEvidence(ctx, row),
    caveats: CAVEATS,
    connection: {
      accountType: row.accountType,
      hasConnectionError: row.hasConnectionError ?? false,
      isActive: row.isActive ?? false,
      updatedAt: row.connectionUpdatedAt ?? row.observedAt,
    },
    observedAt: row.observedAt,
    source:
      "Acquisity product database, plus a live Instantly read for Acquisity-provisioned connections",
    status: "ok",
    webhook: {
      lastEventAt: row.lastWebhookEventAt,
      recentErrorCount: row.recentWebhookErrorCount,
      recentEventCount: row.recentWebhookEventCount,
      registeredCount: row.webhookRegisteredCount,
    },
    workspace: scope.organizationName,
  });
}

const tool = defineTool({
  description: `Diagnose "my inbox disconnected" and "it says no email accounts connected but they're sending" only for this chat's verified workspace. Returns the saved Instantly connection (Acquisity-provisioned vs user-managed, active flag, saved error presence, update time), saved webhook health (registered webhook count, last event time, recent ${RECENT_WEBHOOK_WINDOW_DAYS}-day event and error counts), and, only for an Acquisity-provisioned connection that is active, a live Instantly sending-account check that follows Instantly's pages to cover every account (accounts.truncated true means only a sample was read): per-account diagnostics (email, status/error code, warmup, slow ramp and provider daily limit; at most 200, non-ready first, with detailsTruncated), total plus ready (active, no error, setup finished, past the 14-day done-for-you warmup), paused, setupPending, initialWarmup, error and unknown counts, each account in exactly one, plus any accounts that used Instantly within ${Math.round(RECENT_ACTIVITY_WINDOW_MS / 86_400_000)} days (recently sending) while Instantly reports a negative/error status - the known stale-sync mismatch. accounts.available false explains why the live check did not run (no connection, user-managed workspace, connection off, or Instantly could not be read); this is never the same as zero accounts. No SQL, workspace or field selector is accepted.`,
  execute: (_input, ctx: ToolContext) =>
    readWidgetInboxHealth(ctx as unknown as ProviderContext),
  inputSchema: widgetInboxHealthInput,
  outputSchema: widgetInboxHealthOutput,
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) ? tool : null,
  },
});
