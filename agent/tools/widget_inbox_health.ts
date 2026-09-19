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
/** Stale-sync accounts (recent activity, error status) surfaced in the result. */
const MISMATCH_LIMIT = 25;
const RECENT_WEBHOOK_WINDOW_DAYS = 7;
/**
 * A sending account counts as "recently active" when Instantly last used it within this
 * window. ponytail: fixed 3-day window as a recency proxy for "actively sending"; make it
 * configurable if a shorter/longer campaign cadence produces false positives or negatives.
 */
const RECENT_ACTIVITY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

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
const accounts = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    error: z.number().int().nonnegative(),
    healthy: z.number().int().nonnegative(),
    staleSyncAccounts: z.array(staleSyncAccount).max(MISMATCH_LIMIT),
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
    warming: z.number().int().nonnegative(),
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
        and e.outcome = 'error') as "recentWebhookErrorCount"`;
}

const dbRow = z.object({
  accountType: z.enum(["user_owned", "system_provisioned"]).nullable(),
  authorized: z.boolean(),
  connectionUpdatedAt: timestamp.nullable(),
  hasConnectionError: z.boolean().nullable(),
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
  email: z.string().max(320).optional(),
  setup_pending: z.boolean().nullish(),
  status: z.number().optional(),
  timestamp_last_used: z.string().nullish(),
});

const CAVEATS = [
  "Connection and webhook facts are saved product state, not a live provider check.",
  "A saved connection error does not establish a current failure by itself.",
  "Live account status is only checked for Acquisity-provisioned connections; a user-managed Instantly workspace cannot be verified as belonging to this organization.",
];

function bucketAccounts(items: unknown[]): {
  buckets: { error: number; healthy: number; warming: number };
  staleSyncAccounts: z.infer<typeof staleSyncAccount>[];
} {
  const buckets = { error: 0, healthy: 0, warming: 0 };
  const staleSyncAccounts: z.infer<typeof staleSyncAccount>[] = [];
  const now = Date.now();
  for (const raw of items) {
    const account = instantlyAccount.parse(raw);
    if (typeof account.status === "number") {
      if (account.status > 0) {
        buckets.healthy += 1;
      } else if (account.status < 0) {
        buckets.error += 1;
      }
    }
    if (account.setup_pending === true) {
      buckets.warming += 1;
    }
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
  return { buckets, staleSyncAccounts };
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
    const page = await readInstantlySubworkspace(
      { id: row.workspaceId },
      "accounts",
      { limit: ACCOUNTS_LIMIT },
      { client: executorClient(ctx), signal: ctx.abortSignal }
    );
    const { buckets, staleSyncAccounts } = bucketAccounts(page.items);
    return {
      available: true,
      error: buckets.error,
      healthy: buckets.healthy,
      staleSyncAccounts,
      total: page.items.length,
      truncated: page.nextStartingAfter !== null,
      warming: buckets.warming,
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
  description: `Diagnose "my inbox disconnected" and "it says no email accounts connected but they're sending" only for this chat's verified workspace. Returns the saved Instantly connection (Acquisity-provisioned vs user-managed, active flag, saved error presence, update time), saved webhook health (registered webhook count, last event time, recent ${RECENT_WEBHOOK_WINDOW_DAYS}-day event and error counts), and, only for an Acquisity-provisioned connection that is active, a live Instantly sending-account check: total, healthy, error and warming counts, plus any accounts that used Instantly within ${Math.round(RECENT_ACTIVITY_WINDOW_MS / 86_400_000)} days (recently sending) while Instantly reports a negative/error status - the known stale-sync mismatch. accounts.available false explains why the live check did not run (no connection, user-managed workspace, connection off, or Instantly could not be read); this is never the same as zero accounts. No SQL, workspace or field selector is accepted.`,
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
