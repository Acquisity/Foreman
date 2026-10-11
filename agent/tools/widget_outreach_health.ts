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
import { diagnosticText } from "#lib/widget-diagnostic-text.js";
import { liveToolInput } from "#lib/widget-live-policy.js";
import { replayable } from "#lib/widget-replay.js";
import {
  isWidgetSupport,
  requireWidgetContext,
  type WidgetContext,
  widgetContextSchema,
} from "#lib/widget-scope.js";

const CAMPAIGN_PAGE_SIZE = 20;
const RECENT_SEND_DAYS = 7;
const MAX_WINDOW_DAYS = 31;
const PAUSE_REASON_CHARS = 300;
const STATUS_HISTORY_LIMIT = 10;
const STATUS_MESSAGE_CHARS = 200;
const LEAD_EVENT_LIMIT = 25;
const EARLY_EXAMPLE_LIMIT = 10;
/** Instantly campaign status codes, as Acquisity's mapInstantlyStatusToOur reads them. */
const PROVIDER_STATUS_BY_CODE: Record<number, string> = {
  [-99]: "account_suspended",
  [-2]: "bounce_protect",
  [-1]: "accounts_unhealthy",
  0: "draft",
  1: "active",
  2: "paused",
  3: "completed",
  4: "running_subsequences",
};

const metricDate = z.iso.date();
export const widgetOutreachHealthInput = z
  .strictObject({
    after: z.uuid().nullish(),
    afterInboxId: z.uuid().nullish(),
    campaignId: z.uuid().nullish(),
    endDate: metricDate.nullish(),
    leadEmail: z.email().max(320).nullish(),
    startDate: metricDate.nullish(),
  })
  .refine((input) => {
    if ((input.afterInboxId || input.leadEmail) && !input.campaignId) {
      return false;
    }
    if (!(input.startDate || input.endDate)) {
      return true;
    }
    if (!(input.startDate && input.endDate)) {
      return false;
    }
    const days =
      (Date.parse(input.endDate) - Date.parse(input.startDate)) / 86_400_000;
    return days >= 0 && days < 31;
  }, "Inbox pagination and a lead's history require campaignId; call this tool without them first to list campaigns and their ids. Dates must include both startDate and endDate and span at most 31 inclusive days.");
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
    providerStatus: z.string().max(40).nullable(),
    sendingRules: z.object({
      maxNewLeadsPerDay: count.nullable(),
      minutesBetweenEmails: count.nullable(),
      newLeadsFirst: z.boolean().nullable(),
      randomExtraMinutesMax: count.nullable(),
      // Optional so saved replays from before it existed still parse.
      reading: z.string().nullish(),
    }),
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
  newLeadsContacted: count.nullable(),
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
    earlyFollowUps: z
      .object({
        earlyCount: count,
        earlyLeads: count,
        examples: z
          .array(
            z.object({
              at: timestamp,
              configuredDelayDays: count,
              leadEmail: z.string().max(320),
              previousAt: timestamp,
              sendingInbox: z.string().max(320).nullable(),
              step: count,
            })
          )
          .max(EARLY_EXAMPLE_LIMIT),
        followUpsChecked: count,
        sameDayCount: count,
        withoutPreviousSend: count,
      })
      .nullable(),
    endDate: dateStr,
    lead: z
      .object({
        bounceCount: count.nullable(),
        email: z.string().max(320),
        events: z
          .array(
            z.object({
              at: timestamp,
              eventType: z.string().max(64),
              sendingInbox: z.string().max(320).nullable(),
              step: count.nullable(),
              variant: count.nullable(),
            })
          )
          .max(LEAD_EVENT_LIMIT),
        inCampaign: z.boolean(),
        openCount: count.nullable(),
        pushedToProvider: z.boolean().nullable(),
        status: z.string().max(64).nullable(),
        statusAt: timestamp.nullable(),
      })
      .nullable(),
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
    sequenceStepDelays: z.array(count.nullable()).max(20).nullable(),
    startDate: dateStr,
    statusHistory: z
      .array(
        z.object({
          at: timestamp,
          message: z.string().max(STATUS_MESSAGE_CHARS * 2),
          status: z.string().max(40).nullable(),
        })
      )
      .max(STATUS_HISTORY_LIMIT),
    stepSends: z
      .array(
        z.object({ sent: count, snapshotAt: timestamp.nullable(), step: count })
      )
      .max(20),
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
  pauseReason: z
    .string()
    .max(PAUSE_REASON_CHARS * 2)
    .nullable(),
  recentSends: z.array(dailySend).max(MAX_WINDOW_DAYS),
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
    caveats: z.array(z.string()).max(8),
    inboxes,
    nextAfter: z.uuid().nullable(),
    observedAt: timestamp,
    source: z.literal(
      "Acquisity product database; live sending-provider evidence in live"
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
  // With dates, every listed campaign's daily sends cover the window, so one call answers "what sent when".
  const recentWindow = input.startDate
    ? `and cm.date >= (${startDate})::text and cm.date <= (${endDate})::text`
    : "";
  const inboxCursor = input.afterInboxId
    ? `and mi.id > '${input.afterInboxId}'::uuid`
    : "";
  // The public metrics API reads this same overview. Date-window rows and saved
  // account selections are product data not exposed by that public endpoint.
  const lead = input.leadEmail?.replaceAll("'", "''");
  // Instantly's step counts from 1 (the first email); only email events carry the inbox.
  const leadJson = lead
    ? `(select jsonb_build_object(
      'email', '${lead}',
      'inCampaign', l.id is not null, 'status', l.status, 'statusAt', l.status_event_occurred_at,
      'openCount', l.email_open_count, 'bounceCount', l.email_bounce_count,
      'pushedToProvider', case when l.id is null then null else l.provider_lead_id is not null end,
      'events', coalesce((select jsonb_agg(to_jsonb(ev) order by ev.at desc) from (
        select e.created_at as at, left(e.event_type, 64) as "eventType",
          left(e.payload->>'email_account', 320) as "sendingInbox",
          case when jsonb_typeof(e.payload->'step') = 'number' and (e.payload->>'step') ~ '^[0-9]{1,4}$'
            then (e.payload->>'step')::int end as step,
          case when jsonb_typeof(e.payload->'variant') = 'number' and (e.payload->>'variant') ~ '^[0-9]{1,4}$'
            then (e.payload->>'variant')::int end as variant
        from outreach_webhook_event e
        where e.organization_id = c.organization_id and e.provider_id = c.provider_id
          and e.provider_campaign_id = c.provider_campaign_id
          and e.lead_email = any(array['${lead}', lower('${lead}')])
        order by e.created_at desc limit ${LEAD_EVENT_LIMIT}
      ) ev), '[]'::jsonb))
      from (select 1) one left join lateral (
        select cl.id, cl.status, cl.status_event_occurred_at, cl.email_open_count,
          cl.email_bounce_count, cl.provider_lead_id
        from outreach_campaign_lead cl
        where cl.organization_id = c.organization_id and cl.campaign_id = c.id
          and cl.deleted_at is null and lower(cl.email) = lower('${lead}')
        order by cl.created_at desc limit 1
      ) l on true)`
    : "null::jsonb";
  // Follow-up sends in the window, each against the same lead's latest send of
  // the step before it. A step's delay is the wait before that step (Acquisity's
  // sequence editor shows it between the two steps), and provider steps count
  // from 1, so step n's delay is the nth sequence entry.
  // ponytail: lookback is the largest delay capped at 31 days; an earlier step
  // older than that is counted in withoutPreviousSend, never as early.
  const earlyJson = `(with d as (
      select st.n::int as step, (st.value->>'delay')::int as delay
      from jsonb_array_elements(case when jsonb_typeof(c.settings->'sequences'->0->'steps') = 'array'
        then c.settings->'sequences'->0->'steps' else '[]'::jsonb end) with ordinality st(value, n)
      where st.n <= 20 and (st.value->>'delay') ~ '^[0-9]{1,3}$'
    ), s as (
      select lower(e.lead_email) as lead, (e.payload->>'step')::int as step, e.created_at as at,
        left(e.payload->>'email_account', 320) as inbox
      from outreach_webhook_event e
      where e.organization_id = c.organization_id and e.provider_id = c.provider_id
        and e.provider_campaign_id = c.provider_campaign_id and e.event_type = 'email_sent'
        and e.lead_email is not null
        and jsonb_typeof(e.payload->'step') = 'number' and (e.payload->>'step') ~ '^[0-9]{1,4}$'
        and e.created_at >= (${startDate}) - (select least(coalesce(max(delay), 0), 31) from d)
        and e.created_at < (${endDate}) + 1
    ), f as (
      select s.lead, s.step, s.at, s.inbox, d.delay, max(p.at) as "previousAt"
      from s join d on d.step = s.step
      left join s p on p.lead = s.lead and p.step = s.step - 1 and p.at <= s.at
      where s.step >= 2 and s.at >= (${startDate})
      group by s.lead, s.step, s.at, s.inbox, d.delay
    ), early as (
      select * from f where f."previousAt" is not null
        and f.at - f."previousAt" < make_interval(days => f.delay)
    )
    select jsonb_build_object(
      'followUpsChecked', (select count(*) from f),
      'withoutPreviousSend', (select count(*) from f where f."previousAt" is null),
      'earlyCount', (select count(*) from early),
      'earlyLeads', (select count(distinct lead) from early),
      'sameDayCount', (select count(*) from early where early.at - early."previousAt" < interval '1 day'),
      'examples', coalesce((select jsonb_agg(to_jsonb(x) order by x.at desc) from (
        select left(lead, 320) as "leadEmail", step, delay as "configuredDelayDays",
          "previousAt", at, inbox as "sendingInbox"
        from early order by at desc limit ${EARLY_EXAMPLE_LIMIT}
      ) x), '[]'::jsonb)))`;
  const diagnostics = input.campaignId
    ? `jsonb_build_object(
    'lead', ${leadJson},
    'earlyFollowUps', ${earlyJson},
    'startDate', (${startDate})::text, 'endDate', (${endDate})::text,
    'dailyMetrics', coalesce((select jsonb_agg(to_jsonb(d) order by d.date) from (
      select cm.date, cm.emails_sent as "emailsSent", cm.emails_delivered as "emailsDelivered",
        cm.emails_opened as "emailsOpened", cm.emails_bounced as "emailsBounced",
        cm.replies_received as "repliesReceived", cm.meetings_scheduled as "meetingsScheduled",
        cm.new_leads_contacted_count as "newLeadsContacted", cm.updated_at as "updatedAt"
      from outreach_campaign_metrics cm
      where cm.organization_id = c.organization_id and cm.campaign_id = c.id
        and cm.date >= (${startDate})::text and cm.date <= (${endDate})::text
      order by cm.date limit 31
    ) d), '[]'::jsonb),
    'statusHistory', coalesce((select jsonb_agg(to_jsonb(h) order by h.at desc) from (
      select coalesce(ca.occurred_at, ca.created_at) as at, ca.status,
        left(ca.message, ${STATUS_MESSAGE_CHARS}) as message
      from outreach_campaign_activity ca
      where ca.organization_id = c.organization_id and ca.campaign_id = c.id
        and (ca.message like 'Campaign status updated to %' or ca.message like 'Campaign launch failed: %')
      order by coalesce(ca.occurred_at, ca.created_at) desc limit ${STATUS_HISTORY_LIMIT}
    ) h), '[]'::jsonb),
    'stepSends', coalesce((select jsonb_agg(to_jsonb(s) order by s.step) from (
      select sv.step::int as step, sum(sv.sent) as sent, max(sv.snapshot_at) as "snapshotAt"
      from outreach_campaign_step_variant_metrics sv
      where sv.organization_id = c.organization_id and sv.campaign_id = c.id
        and sv.step ~ '^[0-9]{1,4}$' and sv.sent is not null
      group by sv.step::int order by 1 limit 20
    ) s), '[]'::jsonb),
    'sequenceStepDelays', (select jsonb_agg(case when (st.value->>'delay') ~ '^[0-9]{1,6}$'
        then to_jsonb((st.value->>'delay')::int) else null end order by st.n)
      from jsonb_array_elements(case when jsonb_typeof(c.settings->'sequences'->0->'steps') = 'array'
        then c.settings->'sequences'->0->'steps' else '[]'::jsonb end) with ordinality st(value, n)
      where st.n <= 20),
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
      left(c.pause_reason, ${PAUSE_REASON_CHARS}) as "pauseReason",
      c.provider_campaign_id as "providerCampaignId", p.provider,
      p.account_type as "accountType", p.workspace_id as "providerWorkspaceId",
      c.total_leads as "totalLeads", c.updated_at as "updatedAt", c.created_at as "createdAt",
      c.metadata->'providerData'->>'not_sending_status' as "notSendingStatusRaw",
      sched."fromTime", sched."toTime", sched.timezone, sched.days, sched."dailyLimit",
      coalesce((select jsonb_agg(to_jsonb(dm)) from (
        select cm.date, cm.emails_sent as "emailsSent"
        from outreach_campaign_metrics cm
        where cm.organization_id = c.organization_id and cm.campaign_id = c.id
          ${recentWindow}
        order by cm.date desc limit ${input.startDate ? MAX_WINDOW_DAYS : RECENT_SEND_DAYS}
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
    -- A campaign that stopped sending is usually paused or needs attention, and
    -- that is the one the customer asks about: only drafts and archived stay out.
    where c.display_status in ('active', 'paused', 'attention_needed', 'completed')
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
  createdAt: timestamp.nullish(),
  dailyLimit: count.nullable(),
  days: z.record(z.string(), z.boolean()).nullable(),
  diagnostics: campaignDiagnostics,
  fromTime: z.string().max(16).nullable(),
  id: z.uuid(),
  leadsNotPushedCount: count,
  name: z.string().max(600),
  notSendingStatusRaw: z.string().nullable(),
  pauseReason: z
    .string()
    .max(PAUSE_REASON_CHARS * 2)
    .nullable(),
  provider: z.string().max(100),
  providerCampaignId: z.string().max(200),
  providerWorkspaceId: z.string().max(200).nullable(),
  recentSends: z.array(dailySend).max(MAX_WINDOW_DAYS),
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
    const diagnostics = row.diagnostics
      ? {
          ...row.diagnostics,
          statusHistory: row.diagnostics.statusHistory.map((event) => ({
            ...event,
            message: diagnosticText(event.message, STATUS_MESSAGE_CHARS) ?? "",
          })),
        }
      : null;
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
        reason: "No live provider read for this campaign.",
      },
      name: row.name,
      notSendingReason: reason,
      notSendingReasonCode: code,
      pauseReason: diagnosticText(row.pauseReason, PAUSE_REASON_CHARS),
      recentSends: row.recentSends,
      // 0 is the settings column's empty default, not a cap: live 2026-09-23 it
      // was read as "your limit is 0, which stops all sending".
      savedDailyLimitPerInbox: row.dailyLimit || null,
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
      "Campaign fields are saved product state; only live contains a provider read. savedDailyLimitPerInbox is the saved per-inbox allocation, not a live campaign cap, and null means none is saved, never a limit of zero. Sending limits are set by Acquisity: the customer cannot see or change them anywhere in the product, so never tell the customer to change a limit and never describe a limit as the customer's setting.",
      "pauseReason is the reason Acquisity saved when it paused the campaign itself or the provider did (for example accounts unhealthy, bounce protection, a high bounce rate, a subscription ending, or completed with nothing sent); the customer also sees it on the campaign's status badge. null means no reason was saved, which is what a pause the customer made themselves looks like: say no automatic pause reason is recorded, never that the cause is unknown to everyone. diagnostics.statusHistory lists the campaign's last 10 saved status changes, newest first, with when each happened; it shows when a campaign was paused or resumed, not who did it. live.providerStatus is the sending provider's current status code (accounts_unhealthy, bounce_protect and account_suspended are provider pauses).",
      "notSendingReason reflects the provider's last saved code, not a live check; an unmapped code returns null, not a reason.",
      "Missing metric rows do not mean zero activity. No click metric is available in this result; never report a click count or treat opens as clicks.",
      "recentSends covers the requested date window when startDate and endDate were passed, else only the last 7 saved days. diagnostics.dailyMetrics covers the inclusive requested date window; missing days are unknown, not zero. overview is a separate cumulative saved snapshot. Neither is dispatch history or proof of individual delivery.",
      "diagnostics.lead appears only when leadEmail was passed with campaignId: whether that lead is in the campaign, its saved status, open and bounce counts, whether it reached the provider, and its last 25 saved provider events newest first (email_sent, email_opened, email_bounced, reply_received and others). On an event, step 1 is the first email and step 2 the first follow-up, and sendingInbox is the inbox that sent it. Events come from saved provider webhooks: a missing event is not proof the email was not sent, and no email text is included. diagnostics.earlyFollowUps checks every follow-up sent in the requested date window against the same lead's latest send of the step before it: earlyCount follow-ups (to earlyLeads leads) went out sooner than that step's configured delay, sameDayCount of them within 24 hours, with up to 10 newest examples (the lead, which follow-up as step 2 = first follow-up, both send times, the configured delay, and the inbox that sent it). These are the customer's own leads; name them when asked. withoutPreviousSend follow-ups had no saved earlier send to compare. Saved provider webhooks, not a live check: earlyCount 0 means none found in saved sends, and a gap a few hours short of the delay can come from the sending schedule.",
      "diagnostics.stepSends counts saved cumulative sends per sequence step (step 0 is the first email, step 1 the first follow-up; never say 'step 0' to the customer, say 'first email' and 'first follow-up'); sequenceStepDelays is the configured delay in days on each step. A campaign whose stepSends has only step 0, after its first sends are older than the configured delay, has no saved numeric-step evidence of follow-up sends. Say so plainly: only first emails have been sent and no follow-up has gone out. A dailyMetrics day where emailsSent equals newLeadsContacted means every send that day was a first email. For a question about a whole campaign's follow-ups, answer from these campaign figures before reading any single thread, and do not ask the customer for a prospect name these figures already answer. This is a saved snapshot, not a live dispatch check; an empty stepSends means unknown, not zero.",
      "Inbox health and assignments are saved state, not a live send test or confirmed provider assignment. Assignment counts cover the entire saved selection; accounts are paginated with nextAfterInboxId. configuredCount null means no readable saved selection; a mismatch with matchedCount can indicate duplicate entries or entries that could not be matched to owned inboxes.",
    ],
    inboxes: result.inboxes,
    nextAfter:
      rows.length > CAMPAIGN_PAGE_SIZE ? rows[CAMPAIGN_PAGE_SIZE - 1].id : null,
    observedAt: result.observedAt,
    source:
      "Acquisity product database; live sending-provider evidence in live",
    status: "ok",
    workspace: context.organizationName,
  });
}

const providerCampaign = z.object({
  daily_limit: count.nullish(),
  // The names Acquisity's buildCampaignObject sends when it creates the campaign.
  daily_max_leads: count.nullish(),
  email_gap: count.nullish(),
  id: z.string().max(200),
  not_sending_status: z.number().int().nullish(),
  prioritize_new_leads: z.boolean().nullish(),
  random_wait_max: count.nullish(),
  status: z.number().int(),
  timestamp_updated: timestamp.nullish(),
});

const NEW_CAMPAIGN_DAYS = 14;

/**
 * Plain reading of the sending rules from data already in hand, so the model
 * connects them to "not sending" (wrun ...V4AYD, ...0H5YQP read them and didn't).
 */
export function readSendingRules(
  rules: { maxNewLeadsPerDay: number | null; newLeadsFirst: boolean | null },
  row: Pick<
    z.infer<typeof campaignRow>,
    "createdAt" | "leadsNotPushedCount" | "recentSends"
  >,
  now: number
): string | null {
  const readings: string[] = [];
  if (rules.newLeadsFirst && row.leadsNotPushedCount > 0) {
    readings.push(
      `New leads come first and ${row.leadsNotPushedCount} leads have not had a first email yet, so follow-ups wait until those leads get one. This is the likely reason follow-ups are low, not a certainty.`
    );
  }
  // ponytail: "new" is created in the last 14 days and "near" is 90% of the
  // cap on the latest saved day; tune either if a case shows it misfires.
  const latest = row.recentSends.find((day) => day.emailsSent !== null);
  const isNew =
    row.createdAt &&
    now - Date.parse(row.createdAt) < NEW_CAMPAIGN_DAYS * 86_400_000;
  if (
    isNew &&
    rules.maxNewLeadsPerDay &&
    latest?.emailsSent &&
    latest.emailsSent >= rules.maxNewLeadsPerDay * 0.9
  ) {
    readings.push(
      `This campaign is new and its daily sends are at or near its cap of ${rules.maxNewLeadsPerDay} new leads a day, so that daily new-lead cap is what limits first emails.`
    );
  }
  return readings.length ? readings.join(" ") : null;
}

/** The provider's campaign object as live evidence, in neutral field names. */
function liveFromProvider(
  match: unknown,
  row: z.infer<typeof campaignRow>
): z.infer<typeof liveCampaign> {
  const campaign = providerCampaign.parse(match);
  const reason = toNotSendingReason(
    campaign.not_sending_status === null ||
      campaign.not_sending_status === undefined
      ? null
      : String(campaign.not_sending_status)
  );
  const rules = {
    maxNewLeadsPerDay: campaign.daily_max_leads ?? null,
    minutesBetweenEmails: campaign.email_gap ?? null,
    newLeadsFirst: campaign.prioritize_new_leads ?? null,
    randomExtraMinutesMax: campaign.random_wait_max ?? null,
  };
  return {
    available: true,
    campaignDailyLimit: campaign.daily_limit ?? null,
    notSendingReason: reason.reason as z.infer<typeof notSendingReason>,
    notSendingReasonCode: reason.code,
    observedAt: new Date().toISOString(),
    providerStatus: PROVIDER_STATUS_BY_CODE[campaign.status] ?? null,
    sendingRules: {
      ...rules,
      reading: readSendingRules(rules, row, Date.now()),
    },
    statusCode: campaign.status,
    updatedAt: campaign.timestamp_updated ?? null,
  };
}

/** One bounded campaign-list scan per provider workspace, stopping once every wanted id is found. */
async function scanProviderCampaigns(
  ctx: ProviderContext,
  workspaceId: string,
  wanted: Set<string>,
  signal: AbortSignal
): Promise<{ found: Map<string, unknown>; truncated: boolean }> {
  const found = new Map<string, unknown>();
  let startingAfter: string | undefined;
  const cursors = new Set<string>();
  for (let page = 0; page < 3; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the provider cursor determines the next page.
    const result = await readInstantlySubworkspace(
      { id: workspaceId },
      "campaigns",
      { limit: 100, startingAfter },
      { client: executorClient(ctx), signal }
    );
    for (const item of result.items) {
      const id = z.object({ id: z.string() }).safeParse(item).data?.id;
      if (id && wanted.has(id)) {
        found.set(id, item);
      }
    }
    if (found.size === wanted.size || !result.nextStartingAfter) {
      return { found, truncated: false };
    }
    if (cursors.has(result.nextStartingAfter)) {
      break;
    }
    cursors.add(result.nextStartingAfter);
    startingAfter = result.nextStartingAfter;
  }
  return { found, truncated: true };
}

/** Match only the provider identity read from the authorized campaigns, never a model-supplied provider ID. */
async function readLiveCampaigns(
  ctx: ProviderContext,
  rows: z.infer<typeof campaignRow>[]
): Promise<z.infer<typeof liveCampaign>[]> {
  const byWorkspace = new Map<string, Set<string>>();
  for (const row of rows) {
    if (
      row.provider === "instantly" &&
      row.accountType === "system_provisioned" &&
      row.providerWorkspaceId
    ) {
      const wanted = byWorkspace.get(row.providerWorkspaceId) ?? new Set();
      wanted.add(row.providerCampaignId);
      byWorkspace.set(row.providerWorkspaceId, wanted);
    }
  }
  const signal = AbortSignal.any([
    ctx.abortSignal,
    AbortSignal.timeout(20_000),
  ]);
  const scans = new Map(
    await Promise.all(
      [...byWorkspace].map(async ([workspaceId, wanted]) => {
        try {
          return [
            workspaceId,
            await scanProviderCampaigns(ctx, workspaceId, wanted, signal),
          ] as const;
        } catch (error) {
          if (ctx.abortSignal.aborted) {
            throw error;
          }
          return [workspaceId, null] as const;
        }
      })
    )
  );
  return rows.map((row) => {
    if (!byWorkspace.has(row.providerWorkspaceId ?? "")) {
      return {
        available: false,
        reason:
          "No ownership-verified Acquisity-provisioned sending-provider connection for this campaign.",
      };
    }
    const scan = scans.get(row.providerWorkspaceId ?? "");
    if (!scan) {
      return {
        available: false,
        reason:
          "The live campaign read failed; saved evidence remains available.",
      };
    }
    const match = scan.found.get(row.providerCampaignId);
    if (match) {
      return liveFromProvider(match, row);
    }
    return {
      available: false,
      reason: scan.truncated
        ? "Provider campaign scan was truncated before finding this campaign."
        : "The owned campaign was not found in the provider list; this does not establish why it is absent.",
    };
  });
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
    if (evidence.status === "ok" && evidence.campaigns.length > 0) {
      const db = z
        .object({
          rows: z.array(z.object({ records: z.array(campaignRow) })).length(1),
        })
        .parse(providerData(result.data));
      const live = await readLiveCampaigns(
        ctx,
        db.rows[0].records.slice(0, evidence.campaigns.length)
      );
      evidence.campaigns.forEach((campaign, index) => {
        campaign.live = live[index];
      });
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

export const tool = defineTool({
  description:
    "Diagnose 'my campaigns stopped sending' or 'leads never went out' only in this chat's verified workspace. Inbox pagination and a lead's history require campaignId; list campaigns first to get ids. Up to 20 campaigns that are active, paused, completed or need attention (name, status, total leads, and pauseReason: why Acquisity or the provider paused it, when saved) with nextAfter for the next page; drafts and archived campaigns are not listed. When the customer names a campaign that is not on this page, read the next page with nextAfter before concluding it does not exist, each with: the provider's saved not-sending reason (outside_schedule_window, waiting_for_leads, campaign_daily_limit_reached, all_accounts_at_daily_limit, provider_error, or null when sending normally or the code is unmapped), the saved sending schedule (days, hours, timezone, and whether the window is inverted so it never opens), the saved per-inbox daily allocation (not the live campaign cap), up to 7 days of recent daily send counts (or, with startDate and endDate and no campaignId, every saved day in that window, at most 31 days: one call answers which campaigns sent on which dates), and a count of that campaign's leads never pushed to the provider (null provider lead id); compare totalLeads with leadsNotPushedCount for a lead count mismatch. Also returns an org-wide connected-inbox summary: total sending accounts and how many are healthy (active and connected). Use null for campaignId to list campaigns first; never invent IDs. Pass campaignId from this tool for saved cumulative metrics, daily sending/delivery/open/bounce/reply/meeting metrics (last 7 calendar days by default; optional startDate and endDate YYYY-MM-DD, inclusive, maximum 31 days), campaign-specific inbox assignments, the last 10 status changes with dates (statusHistory: when it was paused or resumed), saved sends per sequence step and each step's configured delay in days; use those step figures for 'follow-ups are not sending' or 'only step 1 sends' questions. With campaignId it also finds, without any lead named, which leads got a follow-up sooner than its configured delay in the date window (earlyFollowUps: counts, same-day count, up to 10 example leads with both send times and the sending inbox); use it for 'follow-ups went out early' or 'follow-up sent the same day as the first email' and never ask the customer for a lead email first. Pass leadEmail with campaignId for one lead's own history in that campaign: its status and dated sends, opens, bounces and replies, each with the sequence step and the inbox that sent it; use it for 'did my follow-up go to this lead', 'when was this person emailed' or 'which inbox emailed them'. Pass afterInboxId from diagnostics.assignedInboxes.nextAfterInboxId to read additional owned assigned inboxes. Counts cover the full selection, not just that page. Assigned inboxes are Acquisity's saved inbox records, which can outlive the inboxes themselves: when widget_inbox_health's live check ran (accounts.available true), read every account (accounts.truncated false), includes every account's details (accounts.detailsTruncated false), and does not list an assigned inbox, that inbox is no longer in the workspace, so say the campaign points at inboxes it no longer has and tell the customer to add or assign inboxes, never to reconnect them. Compare emails ignoring case. A truncated account read, omitted details or a live account with no email cannot prove an inbox is absent; say its current presence could not be confirmed. Every listed campaign, with or without campaignId, also carries live: the provider's current status (providerStatus, including accounts_unhealthy, bounce_protect and account_suspended), campaign daily limit, not-sending code, and sending rules (live.sendingRules): newLeadsFirst (new leads are prioritized over scheduled follow-ups), maxNewLeadsPerDay (the cap on first emails per day), minutesBetweenEmails and randomExtraMinutesMax (the minimum gap between emails and the random extra wait added to it). When follow-ups aren't sending, or a new campaign sends too few new emails, check these first. sendingRules.reading, when present, says what the rules mean for this campaign: tell the customer that as the likely cause, not a certain one. Acquisity sets these rules; the customer cannot change them in the product. Other fields remain saved state. Live status does not prove actual dispatch or delivery. Acquisity manages provider limits; never tell the customer to change them in Instantly. Unavailable is not empty. No SQL, workspace or field selector is accepted.",
  execute: async (input, ctx: ToolContext) =>
    readWidgetOutreachHealth(
      ctx,
      liveToolInput(
        "widget_outreach_health",
        input,
        requireWidgetContext(ctx.session.auth.initiator).liveAsOf
      )
    ),
  inputSchema: widgetOutreachHealthInput,
  outputSchema: widgetOutreachHealthOutput,
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator)
        ? replayable("widget_outreach_health", tool)
        : null,
  },
});
