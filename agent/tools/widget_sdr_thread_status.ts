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

const THREAD_PAGE_SIZE = 25;
const FOLLOWUP_LIMIT = 10;
const APPOINTMENT_LIMIT = 5;
const ACCOUNT_LIMIT = 6;
const REPLY_WINDOW_DAYS = 30;

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const selector = z
  .uuid()
  .optional()
  // A model that cannot omit an optional field fills it with the nil UUID. That
  // is "not provided", never a selector: read literally it made 44 of 63 calls
  // in one audit fail and the first page was never read.
  .transform((value) => (value === NIL_UUID ? undefined : value));

export const widgetSdrInput = z
  .strictObject({
    after: selector.describe(
      "Omit for the first page. For later pages pass only the nextAfter returned by a previous ok call. Never invent a cursor."
    ),
    threadId: selector.describe(
      "Omit to list threads. Only a thread id returned by a previous ok call."
    ),
  })
  // A thread read has no pages, so a cursor sent alongside it is ignored.
  .transform(({ after, threadId }) => ({
    after: threadId ? undefined : after,
    threadId,
  }));
export type WidgetSdrInput = z.input<typeof widgetSdrInput>;

const count = z.number().int().nonnegative();
const timestamp = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));
const zone = z.string().max(64);
const controlLevel = z.enum([
  "automated",
  "human_takeover",
  "dnc",
  "paused",
  "escalated",
]);
const lifecycle = z.enum([
  "contacted",
  "replied",
  "slots_sent",
  "booked",
  "completed",
  "declined",
  "no_response",
]);
const interestLevel = z.enum(["unknown", "low", "medium", "high", "very_high"]);

const threadStatus = z.object({
  controlLevel: controlLevel.nullable(),
  id: z.uuid(),
  interestLevel: interestLevel.nullable(),
  isOutOfOffice: z.boolean(),
  lastMessageAt: timestamp.nullable(),
  lifecycle: lifecycle.nullable(),
  nextFollowupAt: timestamp.nullable(),
  prospectTimezone: zone,
});
const threadSummary = threadStatus.extend({
  hasActiveAppointment: z.boolean(),
  hasPendingFollowup: z.boolean(),
});
const followup = z.object({
  executedAt: timestamp.nullable(),
  scheduledAt: timestamp,
  sequenceIndex: count,
  skipReason: z.string().max(200).nullable(),
  status: z.enum(["pending", "sent", "cancelled", "skipped"]),
  totalInSequence: count,
});
const appointment = z.object({
  canceledAt: timestamp.nullable(),
  clientTimeZone: zone,
  durationInMinutes: count,
  hasMeetingUrl: z.boolean(),
  id: z.uuid(),
  origin: z.string().max(40).nullable(),
  rescheduleCount: count,
  startAt: timestamp,
  status: z.enum(["scheduled", "canceled", "rejected"]),
  supersededByAppointmentId: z.uuid().nullable(),
});
const calendarAccount = z.object({
  failureCount: count,
  invalid: z.boolean(),
  type: z.enum(["google", "outlook"]),
});
const conferencingAccount = z.object({
  invalid: z.boolean(),
  type: z.enum(["zoom_video"]),
});
const replySync = z.object({
  replyEventsLast30d: count.nullable(),
  storedInboundLast30d: count,
  storedInboundTotal: count,
  unresolvedReplyEventsLast30d: count.nullable(),
});
/** Host and settings expose configuration only; no name, email or account key of the assigned handler. */
const workspace = z.object({
  aiSdrEnabled: z.boolean().nullable(),
  aiSdrV2Enabled: z.boolean().nullable(),
  hasSettings: z.boolean(),
  host: z
    .object({
      calendarAccounts: z.array(calendarAccount).max(ACCOUNT_LIMIT),
      conferencingAccounts: z.array(conferencingAccount).max(ACCOUNT_LIMIT),
      conferencingLinkType: z.enum(["dynamic", "static"]),
      hasStaticMeetingLink: z.boolean(),
      timezone: zone,
      workHoursDays: z.array(z.string().max(16)).max(7),
    })
    .nullable(),
});
const evidence = z.discriminatedUnion("read", [
  z.object({
    nextAfter: z.uuid().nullable(),
    read: z.literal("threads"),
    threads: z.array(threadSummary).max(THREAD_PAGE_SIZE),
    workspace,
  }),
  z.object({
    appointments: z.array(appointment).max(APPOINTMENT_LIMIT),
    followups: z.array(followup).max(FOLLOWUP_LIMIT),
    possibleReplySyncGap: z.boolean().nullable(),
    read: z.literal("thread"),
    replySync,
    thread: threadStatus,
    workspace,
  }),
]);
export const widgetSdrOutput = z.union([
  z.object({
    caveats: z.array(z.string()).max(6),
    evidence,
    observedAt: timestamp,
    source: z.literal(
      "Acquisity product database; saved state, not a live calendar or provider check"
    ),
    status: z.literal("ok"),
    workspace: z.string().max(500),
  }),
  z.object({
    message: z.string(),
    status: z.enum([
      "unavailable",
      "not_available",
      "denied",
      "invalid_cursor",
    ]),
  }),
]);
export type WidgetSdrOutput = z.infer<typeof widgetSdrOutput>;

/** Fixed statements only; every product join hangs off the authorized workspace. */
export function buildWidgetSdrQuery(
  context: WidgetContext,
  raw: WidgetSdrInput
): string {
  const scope = widgetContextSchema.parse(context);
  const input = widgetSdrInput.parse(raw);
  const authorization = `with authorized as (
    select o.id, o.ai_sdr_assigned_call_handler_id as handler_id
    from organization o join member m on m.organization_id = o.id
    where o.id = '${scope.organizationId}'::uuid and m.user_id = '${scope.userId}'::uuid
      and o.deleted_at is null and m.deleted_at is null and m.role in ('owner', 'admin')
      and (o.partner_id is null or o.partner_id = '${scope.partnerId}'::uuid)
  )`;
  const workspaceJson = `(select to_jsonb(w) from (
    select (s.id is not null) as "hasSettings", s.ai_sdr_enabled as "aiSdrEnabled",
      s.ai_sdr_v2_enabled as "aiSdrV2Enabled",
      (select to_jsonb(h) from (
        select u.timezone, u.conferencing_link_type as "conferencingLinkType",
          (nullif(u.conferencing_static_link, '') is not null) as "hasStaticMeetingLink",
          coalesce((select jsonb_agg(to_jsonb(c)) from (
            select ca.type, ca.invalid, ca.failure_count as "failureCount"
            from integration_email_calendar_account ca
            where ca.user_id = u.id and ca.deleted_at is null order by ca.id limit ${ACCOUNT_LIMIT}
          ) c), '[]'::jsonb) as "calendarAccounts",
          coalesce((select jsonb_agg(to_jsonb(c)) from (
            select cf.type, cf.invalid from integration_conferencing_account cf
            where cf.user_id = u.id order by cf.id limit ${ACCOUNT_LIMIT}
          ) c), '[]'::jsonb) as "conferencingAccounts",
          coalesce((select jsonb_agg(wh.day_of_week) from (
            select distinct wh.day_of_week from scheduling_work_hours wh
            where wh.user_id = u.id and wh.deleted_at is null limit 7
          ) wh), '[]'::jsonb) as "workHoursDays"
        from "user" u join authorized a2 on a2.handler_id = u.id
      ) h) as host
    from authorized a left join ai_sdr_setting s on s.organization_id = a.id
  ) w)`;
  const threadColumns = `t.id, t.control_level as "controlLevel", t.lifecycle,
    t.interest_level as "interestLevel", t.is_out_of_office as "isOutOfOffice",
    t.last_message_at as "lastMessageAt", t.next_followup_at as "nextFollowupAt",
    t.prospect_timezone as "prospectTimezone"`;
  const threadFrom = `from crm_message_thread t join authorized a on a.id = t.organization_id
    where t.deleted_at is null`;
  const eligible =
    "(t.control_level is not null or t.lifecycle is not null or t.interest_level is not null)";
  const cursorRow = `from crm_message_thread t join authorized a on a.id = t.organization_id
    where t.deleted_at is null and ${eligible} and t.id = '${input.after}'::uuid`;
  let selection: string;
  if (input.threadId) {
    selection = `select ${threadColumns},
      coalesce((select jsonb_agg(to_jsonb(f)) from (
        select sf.status, sf.scheduled_at as "scheduledAt", sf.executed_at as "executedAt",
          sf.sequence_index as "sequenceIndex", sf.total_in_sequence as "totalInSequence",
          left(sf.skip_reason, 200) as "skipReason"
        from scheduled_followup sf
        where sf.organization_id = t.organization_id and sf.thread_id = t.id
        order by sf.scheduled_at desc, sf.id desc limit ${FOLLOWUP_LIMIT}
      ) f), '[]'::jsonb) as followups,
      coalesce((select jsonb_agg(to_jsonb(p)) from (
        select ap.id, ap.status, ap.date as "startAt", ap.client_time_zone as "clientTimeZone",
          ap.duration_in_minutes as "durationInMinutes",
          (nullif(ap.meeting_url, '') is not null) as "hasMeetingUrl", ap.origin,
          ap.reschedule_count as "rescheduleCount", ap.canceled_at as "canceledAt",
          ap.superseded_by_appointment_id as "supersededByAppointmentId"
        from scheduling_appointment ap
        where ap.organization_id = t.organization_id and ap.deleted_at is null
          and t.appointment_id is not null
          and (ap.id = t.appointment_id or ap.superseded_by_appointment_id = t.appointment_id)
        order by ap.date desc, ap.id desc limit ${APPOINTMENT_LIMIT}
      ) p), '[]'::jsonb) as appointments,
      (select to_jsonb(r) from (
        select (select count(*) from crm_message m
            where m.organization_id = t.organization_id and m.thread_id = t.id
              and m.direction = 'received') as "storedInboundTotal",
          (select count(*) from crm_message m
            where m.organization_id = t.organization_id and m.thread_id = t.id
              and m.direction = 'received'
              and coalesce(m.received_at, m.created_at) > current_timestamp - interval '${REPLY_WINDOW_DAYS} days') as "storedInboundLast30d",
          (select case when t.prospect_email is null then null else count(*) end from outreach_webhook_event w
            where w.organization_id = t.organization_id
              and w.event_type in ('reply_received', 'auto_reply_received')
              and w.lead_email = t.prospect_email
              and w.created_at > current_timestamp - interval '${REPLY_WINDOW_DAYS} days') as "replyEventsLast30d",
          (select case when t.prospect_email is null then null else count(*) end from outreach_webhook_event w
            where w.organization_id = t.organization_id
              and w.event_type in ('reply_received', 'auto_reply_received')
              and w.lead_email = t.prospect_email
              and w.created_at > current_timestamp - interval '${REPLY_WINDOW_DAYS} days'
              and (w.status in ('pending', 'processing', 'failed') or w.outcome in ('error', 'unfinished'))) as "unresolvedReplyEventsLast30d"
      ) r) as "replySync"
      ${threadFrom} and t.id = '${input.threadId}'::uuid limit 1`;
  } else {
    const cursor = input.after
      ? `and (coalesce(t.last_message_at, t.created_at), t.id) < (
          select coalesce(t.last_message_at, t.created_at), t.id ${cursorRow})`
      : "";
    selection = `select ${threadColumns},
      exists(select 1 from scheduled_followup sf
        where sf.organization_id = t.organization_id and sf.thread_id = t.id
          and sf.status = 'pending') as "hasPendingFollowup",
      exists(select 1 from scheduling_appointment ap
        where ap.organization_id = t.organization_id and ap.id = t.appointment_id
          and ap.deleted_at is null and ap.status = 'scheduled'
          and ap.date >= current_timestamp) as "hasActiveAppointment"
      ${threadFrom}
      and ${eligible}
      ${cursor}
      order by coalesce(t.last_message_at, t.created_at) desc, t.id desc
      limit ${THREAD_PAGE_SIZE + 1}`;
  }
  return `${authorization}
    select (select count(*) = 1 from authorized) as authorized,
      current_timestamp as "observedAt",
      ${input.after ? `exists(select 1 ${cursorRow})` : "true"} as "cursorValid",
      ${workspaceJson} as workspace,
      coalesce((select jsonb_agg(to_jsonb(r)) from (${selection}) r), '[]'::jsonb) as records`;
}

const CAVEATS = [
  "Saved product state is not a live calendar, Zoom or outreach provider check.",
  "Times are UTC instants; compare against prospectTimezone and the host timezone before calling a slot wrong.",
  "Meeting links: with conferencingLinkType static the link is the saved static link (hasStaticMeetingLink), and empty conferencingAccounts is normal, not a fault. Only with dynamic does a missing or invalid conferencing account explain missing links. An invalid or missing calendar account explains unbookable slots either way.",
  "aiSdrEnabled is the workspace's AI SDR switch. aiSdrV2Enabled false only means the workspace runs the earlier AI SDR workflow; it never means AI SDR is off.",
];

/** Parse only the provider envelope and declared fields; never forward raw failure bodies. */
export function parseWidgetSdrEvidence(
  data: unknown,
  context: WidgetContext,
  raw: WidgetSdrInput
): WidgetSdrOutput {
  const input = widgetSdrInput.parse(raw);
  const envelope = z
    .object({
      rows: z
        .array(
          z.object({
            authorized: z.boolean(),
            cursorValid: z.boolean(),
            observedAt: timestamp,
            records: z.array(z.unknown()).max(THREAD_PAGE_SIZE + 1),
            workspace: workspace.nullable(),
          })
        )
        .length(1),
      success: z.literal(true),
      warnings: z.array(z.unknown()).max(0).optional(),
    })
    .parse(providerData(data));
  const [result] = envelope.rows;
  if (!(result.authorized && result.workspace)) {
    return {
      message: "Current workspace access could not be verified.",
      status: "denied",
    };
  }
  if (!result.cursorValid) {
    return {
      message:
        "That cursor is not a nextAfter from this workspace's thread list. This is not an empty result. Retry without after to read the first page, then page only with the nextAfter it returns.",
      status: "invalid_cursor",
    };
  }
  let parsed: z.infer<typeof evidence>;
  if (input.threadId) {
    if (result.records.length === 0) {
      return {
        message:
          "That thread is not available in this chat's workspace. This result does not establish whether it exists in another workspace; do not infer that it does.",
        status: "not_available",
      };
    }
    const [row] = z
      .array(
        threadStatus.extend({
          appointments: z.array(appointment).max(APPOINTMENT_LIMIT),
          followups: z.array(followup).max(FOLLOWUP_LIMIT),
          replySync,
        })
      )
      .length(1)
      .parse(result.records);
    if (row.id.toLowerCase() !== input.threadId.toLowerCase()) {
      throw new Error("Unexpected thread response.");
    }
    parsed = {
      appointments: row.appointments,
      followups: row.followups,
      possibleReplySyncGap:
        row.replySync.replyEventsLast30d === null
          ? null
          : row.replySync.replyEventsLast30d >
            row.replySync.storedInboundLast30d,
      read: "thread",
      replySync: row.replySync,
      thread: threadStatus.parse(row),
      workspace: result.workspace,
    };
  } else {
    const rows = z
      .array(threadSummary)
      .max(THREAD_PAGE_SIZE + 1)
      .parse(result.records);
    parsed = {
      nextAfter:
        rows.length > THREAD_PAGE_SIZE ? rows[THREAD_PAGE_SIZE - 1].id : null,
      read: "threads",
      threads: rows.slice(0, THREAD_PAGE_SIZE),
      workspace: result.workspace,
    };
  }
  return widgetSdrOutput.parse({
    caveats: [
      ...CAVEATS,
      ...(input.threadId
        ? [
            "possibleReplySyncGap compares provider reply events with stored inbound messages over 30 days; a gap is a lead to check, not proof of a lost reply.",
            "A canceled appointment with supersededByAppointmentId was rescheduled, not dropped.",
          ]
        : [
            "Only threads the AI SDR v2 workflow has touched are listed; legacy threads are absent, not missing.",
          ]),
    ],
    evidence: parsed,
    observedAt: result.observedAt,
    source:
      "Acquisity product database; saved state, not a live calendar or provider check",
    status: "ok",
    workspace: context.organizationName,
  });
}

/** Widget reads accept a thread ID or cursor, never a workspace, SQL or field selector. */
export async function readWidgetSdrThreadStatus(
  ctx: ProviderContext,
  input: WidgetSdrInput
): Promise<WidgetSdrOutput> {
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  const query = buildWidgetSdrQuery(scope, input);
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
    return parseWidgetSdrEvidence(result.data, scope, input);
  } catch (error) {
    if (ctx.abortSignal.aborted) {
      throw error;
    }
    // Parser and provider errors may contain customer rows or credentials. Never forward them.
    logOpsEvent(
      "widget.support.sdr_thread_status.failed",
      {
        code: stage,
        outcome: "error",
        tool: "widget_sdr_thread_status",
      },
      console.warn
    );
    return {
      message:
        "AI SDR thread state could not be checked. This is not an empty result; no table in it should be read as empty.",
      status: "unavailable",
    };
  }
}

const tool = defineTool({
  description:
    "Diagnose AI SDR scheduling, booking and reply-sync issues only in this chat's verified workspace. Without threadId: up to 25 recent AI SDR v2 threads (control level, lifecycle, interest, out-of-office, pending follow-up, active appointment) plus the workspace's AI SDR settings and host calendar/Zoom/timezone/work-hours configuration. With threadId (a thread UUID from this workspace): that thread's status, last 10 scheduled follow-ups, linked appointments (status, start, timezone, meeting link present, reschedules), the prospect timezone, and a reply-sync comparison of provider reply events versus stored inbound messages. Paging: a non-null nextAfter means more threads exist and you can read them; never say later threads cannot be inspected while nextAfter is set. Read the next page when the first does not contain what the question needs, a few pages at most, never the whole list. Omit after on the first call; pass after only with a nextAfter returned by a previous ok call, never an invented or placeholder UUID. invalid_cursor means retry without after. Saved state, not a live calendar or provider check. Unavailable and invalid_cursor are not empty. No SQL, workspace or field selector is accepted.",
  execute: async (input, ctx: ToolContext) =>
    readWidgetSdrThreadStatus(ctx, input),
  inputSchema: widgetSdrInput,
  outputSchema: widgetSdrOutput,
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) ? tool : null,
  },
});
