import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { operationPath } from "#lib/executor/bindings.js";
import { executorClient } from "#lib/executor/client.js";
import {
  invokeProvider,
  type ProviderContext,
} from "#lib/executor/dispatch.js";
import { readInstantlySubworkspace } from "#lib/instantly-api.js";
import { PRODUCTION_READ_QUERY_ARGS } from "#lib/lookup-customer.js";
import { logOpsEvent } from "#lib/ops-log.js";
import { providerData } from "#lib/support/conversation.js";
import {
  isWidgetSupport,
  requireWidgetContext,
  type WidgetContext,
  widgetContextSchema,
} from "#lib/widget-scope.js";

const CAMPAIGN_PAGE_SIZE = 20;
const RECENT_SEND_DAYS = 7;

const metricDate = z.iso.date();
export const widgetOutreachHealthInput = z
  .strictObject({
    after: z.uuid().nullish(),
    afterInboxId: z.uuid().nullish(),
    campaignId: z.uuid().nullish(),
    endDate: metricDate.nullish(),
    startDate: metricDate.nullish(),
  })
  .refine((input) => {
    if (input.afterInboxId && !input.campaignId) {
      return false;
    }
    if (!(input.startDate || input.endDate)) {
      return true;
    }
    if (!(input.campaignId && input.startDate && input.endDate)) {
      return false;
    }
    const days =
      (Date.parse(input.endDate) - Date.parse(input.startDate)) / 86_400_000;
    return days >= 0 && days < 31;
  }, "Select a campaign for inbox pagination or a complete date range of at most 31 days.");
export type WidgetOutreachHealthInput = z.infer<
  typeof widgetOutreachHealthInput
>;

const count = z.number().int().nonnegative();
const timestamp = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));
const status = z.enum([
  "draft",
  "active",
  "paused",
  "completed",
  "archived",
  "attention_needed",
]);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dailySend = z.object({ date: dateStr, emailsSent: count.nullable() });
/** Instantly's own `not_sending_status` codes; anything else is left unmapped. */
const NOT_SENDING_REASON_BY_CODE: Record<number, string> = {
  1: "outside_schedule_window",
  2: "waiting_for_leads",
  3: "campaign_daily_limit_reached",
  4: "all_accounts_at_daily_limit",
  99: "provider_error",
};
const notSendingReason = z
  .enum([
    "outside_schedule_window",
    "waiting_for_leads",
    "campaign_daily_limit_reached",
    "all_accounts_at_daily_limit",
    "provider_error",
  ])
  .nullable();
// Saved keys are day indexes, 0 = Sunday .. 6 = Saturday (Acquisity's
// campaign-schedule.ts). A reply read "5": false as a weekend and told the
// customer Friday sending was on, so the model only ever sees day names.
const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
export const namedDays = (days: Record<string, boolean> | null) =>
  days &&
  Object.fromEntries(
    Object.entries(days).map(([key, on]) => [DAY_NAMES[Number(key)] ?? key, on])
  );

const schedule = z.object({
  days: z.record(z.string(), z.boolean()).nullable(),
  fromTime: z.string().max(16).nullable(),
  invertedWindow: z.boolean(),
  timezone: z.string().max(64).nullable(),
  toTime: z.string().max(16).nullable(),
});
const liveCampaign = z.union([
  z.object({
    available: z.literal(true),
    campaignDailyLimit: count.nullable(),
    notSendingReason,
    notSendingReasonCode: z.number().int().nullable(),
    observedAt: timestamp,
    statusCode: z.number().int(),
    updatedAt: timestamp.nullable(),
  }),
  z.object({ available: z.literal(false), reason: z.string() }),
]);
const dailyMetrics = z.object({
  date: dateStr,
  emailsBounced: count,
  emailsDelivered: count,
  emailsOpened: count,
  emailsSent: count,
  meetingsScheduled: count,
  repliesReceived: count,
  updatedAt: timestamp,
});
const assignedInbox = z.object({
  connected: z.boolean(),
  email: z.email(),
  id: z.uuid(),
  status: z.string().max(100),
});
const campaignDiagnostics = z
  .object({
    assignedInboxes: z.object({
      accounts: z.array(assignedInbox).max(101),
      configuredCount: count.nullable(),
      healthyCount: count,
      matchedCount: count,
      nextAfterInboxId: z.uuid().nullable(),
    }),
    dailyMetrics: z.array(dailyMetrics).max(31),
    endDate: dateStr,
    overview: z
      .object({
        bounces: count,
        emailsSent: count,
        meetingsBooked: count,
        opens: count,
        replies: count,
        snapshotAt: timestamp.nullable(),
        unsubscribes: count,
      })
      .nullable(),
    startDate: dateStr,
  })
  .nullable();
const campaignHealth = z.object({
  diagnostics: campaignDiagnostics,
  id: z.uuid(),
  leadsNotPushedCount: count,
  live: liveCampaign,
  name: z.string().max(600),
  notSendingReason,
  notSendingReasonCode: z.number().int().nullable(),
  recentSends: z.array(dailySend).max(RECENT_SEND_DAYS),
  savedDailyLimitPerInbox: count.nullable(),
  schedule: schedule.nullable(),
  status,
  totalLeads: count.nullable(),
  updatedAt: timestamp,
});
const inboxes = z.object({
  healthyAccounts: count,
  totalSendingAccounts: count,
});
export const widgetOutreachHealthOutput = z.union([
  z.object({
    campaigns: z.array(campaignHealth).max(CAMPAIGN_PAGE_SIZE),
    caveats: z.array(z.string()).max(6),
    inboxes,
    nextAfter: z.uuid().nullable(),
    observedAt: timestamp,
    source: z.literal(
      "Acquisity product database; live Instantly evidence only for a selected campaign"
    ),
    status: z.literal("ok"),
    workspace: z.string().max(500),
  }),
  z.object({
    message: z.string(),
    status: z.enum(["unavailable", "denied"]),
  }),
]);
export type WidgetOutreachHealthOutput = z.infer<
  typeof widgetOutreachHealthOutput
>;

/** Fixed statements only; every product join hangs off the authorized workspace. */
export function buildWidgetOutreachHealthQuery(
  context: WidgetContext,
  raw: WidgetOutreachHealthInput
): string {
  const scope = widgetContextSchema.parse(context);
  const input = widgetOutreachHealthInput.parse(raw);
  const authorization = `with authorized as (
    select o.id from organization o join member m on m.organization_id = o.id
    where o.id = '${scope.organizationId}'::uuid and m.user_id = '${scope.userId}'::uuid
      and o.deleted_at is null and m.deleted_at is null and m.role in ('owner', 'admin')
      and (o.partner_id is null or o.partner_id = '${scope.partnerId}'::uuid)
  )`;
  const inboxesJson = `(select to_jsonb(i) from (
    select count(*) as "totalSendingAccounts",
      count(*) filter (where mi.status = 'active' and mi.connected) as "healthyAccounts"
    from mail_inbox mi join authorized a on a.id = mi.organization_id
  ) i) as inboxes`;
  const cursor = input.after ? `and c.id > '${input.after}'::uuid` : "";
  const target = input.campaignId
    ? `and c.id = '${input.campaignId}'::uuid`
    : "";
  const startDate = input.startDate
    ? `'${input.startDate}'::date`
    : "current_date - 6";
  const endDate = input.endDate ? `'${input.endDate}'::date` : "current_date";
  const inboxCursor = input.afterInboxId
    ? `and mi.id > '${input.afterInboxId}'::uuid`
    : "";
  // The public metrics API reads this same overview. Date-window rows and saved
  // account selections are product data not exposed by that public endpoint.
  const diagnostics = input.campaignId
    ? `jsonb_build_object(
    'startDate', (${startDate})::text, 'endDate', (${endDate})::text,
    'dailyMetrics', coalesce((select jsonb_agg(to_jsonb(d) order by d.date) from (
      select cm.date, cm.emails_sent as "emailsSent", cm.emails_delivered as "emailsDelivered",
        cm.emails_opened as "emailsOpened", cm.emails_bounced as "emailsBounced",
        cm.replies_received as "repliesReceived", cm.meetings_scheduled as "meetingsScheduled",
        cm.updated_at as "updatedAt"
      from outreach_campaign_metrics cm
      where cm.organization_id = c.organization_id and cm.campaign_id = c.id
        and cm.date >= (${startDate})::text and cm.date <= (${endDate})::text
      order by cm.date limit 31
    ) d), '[]'::jsonb),
    'overview', (select jsonb_build_object(
      'emailsSent', co.emails_sent_count, 'opens', co.open_count,
      'replies', co.reply_count, 'bounces', co.bounced_count,
      'unsubscribes', co.unsubscribed_count, 'meetingsBooked', co.total_meeting_booked,
      'snapshotAt', co.snapshot_at)
      from outreach_campaign_overview co
      where co.organization_id = c.organization_id and co.campaign_id = c.id),
    'assignedInboxes', (select jsonb_build_object(
      'configuredCount', case when jsonb_typeof(c.settings->'emailAccounts') = 'array'
        then jsonb_array_length(c.settings->'emailAccounts') else null end,
      'matchedCount', count(*),
      'healthyCount', count(*) filter (where mi.status = 'active' and mi.connected),
      'nextAfterInboxId', null,
      'accounts', coalesce((select jsonb_agg(to_jsonb(ai)) from (
        select mi.id, mi.email, mi.status, mi.connected
        from mail_inbox mi where mi.organization_id = c.organization_id
          and jsonb_typeof(c.settings->'emailAccounts') = 'array'
          and c.settings->'emailAccounts' ? mi.email ${inboxCursor}
        order by mi.id limit 101
      ) ai), '[]'::jsonb))
      from mail_inbox mi where mi.organization_id = c.organization_id
        and jsonb_typeof(c.settings->'emailAccounts') = 'array'
        and c.settings->'emailAccounts' ? mi.email)
  )`
    : "null::jsonb";
  const selection = `select ${diagnostics} as diagnostics, c.id, left(c.name, 300) as name, c.status,
      c.provider_campaign_id as "providerCampaignId", p.provider,
      p.account_type as "accountType", p.workspace_id as "providerWorkspaceId",
      c.total_leads as "totalLeads", c.updated_at as "updatedAt",
      c.metadata->'providerData'->>'not_sending_status' as "notSendingStatusRaw",
      sched."fromTime", sched."toTime", sched.timezone, sched.days, sched."dailyLimit",
      coalesce((select jsonb_agg(to_jsonb(dm)) from (
        select cm.date, cm.emails_sent as "emailsSent"
        from outreach_campaign_metrics cm
        where cm.organization_id = c.organization_id and cm.campaign_id = c.id
        order by cm.date desc limit ${RECENT_SEND_DAYS}
      ) dm), '[]'::jsonb) as "recentSends",
      (select count(*) from outreach_campaign_lead l
        where l.organization_id = c.organization_id and l.campaign_id = c.id
          and l.deleted_at is null and l.provider_lead_id is null) as "leadsNotPushedCount"
    from outreach_campaign c
    join authorized a on a.id = c.organization_id
    join outreach_provider p on p.id = c.provider_id and p.organization_id = a.id
    left join lateral (
      select ocs.from_name as "fromTime", ocs.to_time as "toTime", ocs.timezone,
        ocs.days, ocs.volume_inbox_daily as "dailyLimit"
      from outreach__campaign_settings ocs
      where ocs.organization_id = c.organization_id
        and (ocs.campaign_id = c.id or ocs.campaign_id is null)
      order by (ocs.campaign_id is null), ocs.updated_at desc
      limit 1
    ) sched on true
    where c.display_status = 'active'
    ${cursor} ${target}
    order by c.id limit ${CAMPAIGN_PAGE_SIZE + 1}`;
  return `${authorization}
    select (select count(*) = 1 from authorized) as authorized,
      current_timestamp as "observedAt",
      ${inboxesJson},
      coalesce((select jsonb_agg(to_jsonb(r)) from (${selection}) r), '[]'::jsonb) as records`;
}

function toNotSendingReason(raw: string | null): {
  code: number | null;
  reason: string | null;
} {
  if (raw === null) {
    return { code: null, reason: null };
  }
  const code = Number(raw);
  if (!Number.isInteger(code)) {
    return { code: null, reason: null };
  }
  return { code, reason: NOT_SENDING_REASON_BY_CODE[code] ?? null };
}

const campaignRow = z.object({
  accountType: z.enum(["system_provisioned", "user_owned"]).nullable(),
  dailyLimit: count.nullable(),
  days: z.record(z.string(), z.boolean()).nullable(),
  diagnostics: campaignDiagnostics,
  fromTime: z.string().max(16).nullable(),
  id: z.uuid(),
  leadsNotPushedCount: count,
  name: z.string().max(600),
  notSendingStatusRaw: z.string().nullable(),
  provider: z.string().max(100),
  providerCampaignId: z.string().max(200),
  providerWorkspaceId: z.string().max(200).nullable(),
  recentSends: z.array(dailySend).max(RECENT_SEND_DAYS),
  status,
  timezone: z.string().max(64).nullable(),
  toTime: z.string().max(16).nullable(),
  totalLeads: count.nullable(),
  updatedAt: timestamp,
});

/** Parse only the provider envelope and declared fields; never forward raw failure bodies. */
export function parseWidgetOutreachHealthEvidence(
  data: unknown,
  context: WidgetContext
): WidgetOutreachHealthOutput {
  const envelope = z
    .object({
      rows: z
        .array(
          z.object({
            authorized: z.boolean(),
            inboxes: inboxes.nullable(),
            observedAt: timestamp,
            records: z.array(z.unknown()).max(CAMPAIGN_PAGE_SIZE + 1),
          })
        )
        .length(1),
      success: z.literal(true),
      warnings: z.array(z.unknown()).max(0).optional(),
    })
    .parse(providerData(data));
  const [result] = envelope.rows;
  if (!(result.authorized && result.inboxes)) {
    return {
      message: "Current workspace access could not be verified.",
      status: "denied",
    };
  }
  const rows = z
    .array(campaignRow)
    .max(CAMPAIGN_PAGE_SIZE + 1)
    .parse(result.records);
  const campaigns = rows.slice(0, CAMPAIGN_PAGE_SIZE).map((row) => {
    const { code, reason } = toNotSendingReason(row.notSendingStatusRaw);
    const hasSchedule =
      row.fromTime !== null ||
      row.toTime !== null ||
      row.timezone !== null ||
      row.days !== null;
    const { diagnostics } = row;
    if (diagnostics) {
      const { accounts } = diagnostics.assignedInboxes;
      diagnostics.assignedInboxes.nextAfterInboxId =
        accounts.length > 100 ? accounts[99].id : null;
      diagnostics.assignedInboxes.accounts = accounts.slice(0, 100);
    }
    return campaignHealth.parse({
      diagnostics,
      id: row.id,
      leadsNotPushedCount: row.leadsNotPushedCount,
      live: {
        available: false,
        reason: "Select this campaignId to check the provider.",
      },
      name: row.name,
      notSendingReason: reason,
      notSendingReasonCode: code,
      recentSends: row.recentSends,
      savedDailyLimitPerInbox: row.dailyLimit,
      schedule: hasSchedule
        ? {
            days: namedDays(row.days),
            fromTime: row.fromTime,
            invertedWindow: Boolean(
              row.fromTime && row.toTime && row.toTime < row.fromTime
            ),
            timezone: row.timezone,
            toTime: row.toTime,
          }
        : null,
      status: row.status,
      totalLeads: row.totalLeads,
      updatedAt: row.updatedAt,
    });
  });
  return widgetOutreachHealthOutput.parse({
    campaigns,
    caveats: [
      "Campaign fields are saved product state; only live contains a provider read. savedDailyLimitPerInbox is the saved per-inbox allocation, not a live campaign cap. Acquisity manages Instantly limits; do not ask the customer to change them in Instantly.",
      "notSendingReason reflects the provider's last saved code, not a live check; an unmapped code returns null, not a reason.",
      "Missing metric rows do not mean zero activity. No click metric is available in this result; never report a click count or treat opens as clicks.",
      "recentSends covers only the last saved days. diagnostics.dailyMetrics covers the inclusive requested date window; missing days are unknown, not zero. overview is a separate cumulative saved snapshot. Neither is dispatch history or proof of individual delivery.",
      "Inbox health and assignments are saved state, not a live send test or confirmed provider assignment. Assignment counts cover the entire saved selection; accounts are paginated with nextAfterInboxId. configuredCount null means no readable saved selection; a mismatch with matchedCount can indicate duplicate entries or entries that could not be matched to owned inboxes.",
    ],
    inboxes: result.inboxes,
    nextAfter:
      rows.length > CAMPAIGN_PAGE_SIZE ? rows[CAMPAIGN_PAGE_SIZE - 1].id : null,
    observedAt: result.observedAt,
    source:
      "Acquisity product database; live Instantly evidence only for a selected campaign",
    status: "ok",
    workspace: context.organizationName,
  });
}

const providerCampaign = z.object({
  daily_limit: count.nullish(),
  id: z.string().max(200),
  not_sending_status: z.number().int().nullish(),
  status: z.number().int(),
  timestamp_updated: timestamp.nullish(),
});

/** Match only the provider identity read from the authorized campaign, never a model-supplied provider ID. */
async function readLiveCampaign(
  ctx: ProviderContext,
  row: z.infer<typeof campaignRow>
): Promise<z.infer<typeof liveCampaign>> {
  if (
    row.provider !== "instantly" ||
    row.accountType !== "system_provisioned" ||
    !row.providerWorkspaceId
  ) {
    return {
      available: false,
      reason:
        "No ownership-verified Acquisity-provisioned Instantly connection for this campaign.",
    };
  }
  try {
    const signal = AbortSignal.any([
      ctx.abortSignal,
      AbortSignal.timeout(20_000),
    ]);
    let startingAfter: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 3; page += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the provider cursor determines the next page.
      const result = await readInstantlySubworkspace(
        { id: row.providerWorkspaceId },
        "campaigns",
        { limit: 100, startingAfter },
        { client: executorClient(ctx), signal }
      );
      const match = result.items.find(
        (item) =>
          z.object({ id: z.string() }).safeParse(item).data?.id ===
          row.providerCampaignId
      );
      if (match) {
        const campaign = providerCampaign.parse(match);
        const reason = toNotSendingReason(
          campaign.not_sending_status === null ||
            campaign.not_sending_status === undefined
            ? null
            : String(campaign.not_sending_status)
        );
        return {
          available: true,
          campaignDailyLimit: campaign.daily_limit ?? null,
          notSendingReason: reason.reason as z.infer<typeof notSendingReason>,
          notSendingReasonCode: reason.code,
          observedAt: new Date().toISOString(),
          statusCode: campaign.status,
          updatedAt: campaign.timestamp_updated ?? null,
        };
      }
      if (!result.nextStartingAfter) {
        return {
          available: false,
          reason:
            "The owned campaign was not found in the provider list; this does not establish why it is absent.",
        };
      }
      if (cursors.has(result.nextStartingAfter)) {
        break;
      }
      cursors.add(result.nextStartingAfter);
      startingAfter = result.nextStartingAfter;
    }
    return {
      available: false,
      reason:
        "Provider campaign scan was truncated before finding this campaign.",
    };
  } catch (error) {
    if (ctx.abortSignal.aborted) {
      throw error;
    }
    return {
      available: false,
      reason:
        "The live campaign read failed; saved evidence remains available.",
    };
  }
}

/** Widget reads accept an owned campaign selector or a page cursor, never workspace or SQL. */
export async function readWidgetOutreachHealth(
  ctx: ProviderContext,
  input: WidgetOutreachHealthInput
): Promise<WidgetOutreachHealthOutput> {
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  const query = buildWidgetOutreachHealthQuery(scope, input);
  let stage = "configuration";
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
    const evidence = parseWidgetOutreachHealthEvidence(result.data, scope);
    if (
      evidence.status === "ok" &&
      input.campaignId &&
      evidence.campaigns.length === 1
    ) {
      const db = z
        .object({
          rows: z.array(z.object({ records: z.array(campaignRow) })).length(1),
        })
        .parse(providerData(result.data));
      evidence.campaigns[0].live = await readLiveCampaign(
        ctx,
        db.rows[0].records[0]
      );
    }
    return evidence;
  } catch (error) {
    if (ctx.abortSignal.aborted) {
      throw error;
    }
    // Parser and provider errors may contain customer rows or credentials. Never forward them.
    logOpsEvent(
      "widget.support.outreach_health.failed",
      {
        code: stage,
        outcome: "error",
        tool: "widget_outreach_health",
      },
      console.warn
    );
    return {
      message:
        "Outreach health could not be checked. This is not an empty result; no campaign in it should be read as caught up.",
      status: "unavailable",
    };
  }
}

const tool = defineTool({
  description:
    "Diagnose 'my campaigns stopped sending' or 'leads never went out' only in this chat's verified workspace. Up to 20 recent active campaigns (name, status, total leads) with nextAfter for the next page, each with: the provider's saved not-sending reason (outside_schedule_window, waiting_for_leads, campaign_daily_limit_reached, all_accounts_at_daily_limit, provider_error, or null when sending normally or the code is unmapped), the saved sending schedule (days, hours, timezone, and whether the window is inverted so it never opens), the saved per-inbox daily allocation (not the live campaign cap), up to 7 days of recent daily send counts, and a count of that campaign's leads never pushed to the provider (null provider lead id). Also returns an org-wide connected-inbox summary: total sending accounts and how many are healthy (active and connected). Use null for campaignId to list campaigns first; never invent IDs. Pass campaignId from this tool for saved cumulative metrics, daily sending/delivery/open/bounce/reply/meeting metrics (last 7 calendar days by default; optional startDate and endDate YYYY-MM-DD, inclusive, maximum 31 days), and campaign-specific inbox assignments. Pass afterInboxId from diagnostics.assignedInboxes.nextAfterInboxId to read additional owned assigned inboxes. Counts cover the full selection, not just that page. This also fetches live provider status, campaign daily limit and not-sending code for that owned campaign. Other fields remain saved state. Live status does not prove actual dispatch or delivery. Acquisity manages provider limits; never tell the customer to change them in Instantly. Unavailable is not empty. No SQL, workspace or field selector is accepted.",
  execute: async (input, ctx: ToolContext) =>
    readWidgetOutreachHealth(ctx, input),
  inputSchema: widgetOutreachHealthInput,
  outputSchema: widgetOutreachHealthOutput,
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) ? tool : null,
  },
});
