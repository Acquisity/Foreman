import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { operationPath } from "#lib/executor/bindings.js";
import {
  invokeProvider,
  type ProviderContext,
} from "#lib/executor/dispatch.js";
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

export const widgetOutreachHealthInput = z.strictObject({
  after: z.uuid().optional(),
});
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
const campaignHealth = z.object({
  dailyLimit: count.nullable(),
  id: z.uuid(),
  leadsNotPushedCount: count,
  name: z.string().max(600),
  notSendingReason,
  notSendingReasonCode: z.number().int().nullable(),
  recentSends: z.array(dailySend).max(RECENT_SEND_DAYS),
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
      "Acquisity product database; saved state, not a live provider check"
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
  const selection = `select c.id, left(c.name, 300) as name, c.status,
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
    ${cursor}
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
  dailyLimit: count.nullable(),
  days: z.record(z.string(), z.boolean()).nullable(),
  fromTime: z.string().max(16).nullable(),
  id: z.uuid(),
  leadsNotPushedCount: count,
  name: z.string().max(600),
  notSendingStatusRaw: z.string().nullable(),
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
    return campaignHealth.parse({
      dailyLimit: row.dailyLimit,
      id: row.id,
      leadsNotPushedCount: row.leadsNotPushedCount,
      name: row.name,
      notSendingReason: reason,
      notSendingReasonCode: code,
      recentSends: row.recentSends,
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
      "Saved product state is not a live provider check.",
      "notSendingReason reflects the provider's last saved code, not a live check; an unmapped code returns null, not a reason.",
      "Missing metric rows do not mean zero activity.",
      "recentSends covers only the last saved days, not the campaign's full history.",
      "Inbox health is the saved status and connection flag, not a live send test.",
    ],
    inboxes: result.inboxes,
    nextAfter:
      rows.length > CAMPAIGN_PAGE_SIZE ? rows[CAMPAIGN_PAGE_SIZE - 1].id : null,
    observedAt: result.observedAt,
    source:
      "Acquisity product database; saved state, not a live provider check",
    status: "ok",
    workspace: context.organizationName,
  });
}

/** Widget reads accept only a page cursor, never a workspace, SQL or field selector. */
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
    return parseWidgetOutreachHealthEvidence(result.data, scope);
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
    "Diagnose 'my campaigns stopped sending' or 'leads never went out' only in this chat's verified workspace. Up to 20 recent active campaigns (name, status, total leads) with nextAfter for the next page, each with: the provider's saved not-sending reason (outside_schedule_window, waiting_for_leads, campaign_daily_limit_reached, all_accounts_at_daily_limit, provider_error, or null when sending normally or the code is unmapped), the saved sending schedule (days, hours, timezone, and whether the window is inverted so it never opens), the daily send-volume allocation, up to 7 days of recent daily send counts, and a count of that campaign's leads never pushed to the provider (null provider lead id). Also returns an org-wide connected-inbox summary: total sending accounts and how many are healthy (active and connected). Saved state, not a live provider check. Unavailable is not empty. No SQL, workspace or field selector is accepted.",
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
