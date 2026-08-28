import { z } from "zod";
import {
  type AiSdrReportWindows,
  aiSdrReportWindows,
  type ReportWindow,
} from "./ai-sdr-report-window.js";
import { parseReadQueryResult } from "./planetscale.js";

const TOTAL = "__total__";
const NORMALIZED_CAMPAIGN_METHOD =
  "case when c.email_scripts_method = 'lead_magnet' then 'lead-magnet' else c.email_scripts_method end";
export const CAMPAIGN_METHODS = [
  "podcast",
  "direct",
  "interview",
  "lead-magnet",
] as const;
export const LIFECYCLE_STAGES = [
  "replied",
  "slots_sent",
  "booked",
  "completed",
  "declined",
  "no_response",
] as const;

const finiteNumber = z
  .union([z.number(), z.string()])
  .transform(Number)
  .pipe(z.number().finite());
const metricsRowSchema = z.object({
  method: z.string(),
  month_positive: finiteNumber,
  month_replies: finiteNumber,
  month_sent: finiteNumber,
  previous_positive: finiteNumber,
  previous_replies: finiteNumber,
  previous_sent: finiteNumber,
  report_positive: finiteNumber,
  report_replies: finiteNumber,
  report_sent: finiteNumber,
});
const bookingRowSchema = z.object({
  method: z.string(),
  month_booked: finiteNumber,
  previous_booked: finiteNumber,
  report_booked: finiteNumber,
});
const lifecycleRowSchema = z.looseObject({
  month: finiteNumber.optional().default(0),
  previous: finiteNumber.optional().default(0),
  report: finiteNumber.optional().default(0),
  stage: z.string(),
});

export const countComparisonSchema = z.object({
  momPercent: z.number().nullable(),
  previous: z.number(),
  report: z.number(),
  sameWeekLastMonth: z.number(),
  wowPercent: z.number().nullable(),
});
export const rateComparisonSchema = z.object({
  momPercentagePoints: z.number(),
  previous: z.number(),
  report: z.number(),
  sameWeekLastMonth: z.number(),
  wowPercentagePoints: z.number(),
});
const windowSchema = z.object({
  end: z.string(),
  endExclusive: z.string(),
  start: z.string(),
});
const methodResultSchema = z.object({
  bookedMeetingRate: rateComparisonSchema,
  bookedMeetings: countComparisonSchema,
  method: z.string(),
  positiveReplies: countComparisonSchema,
});
const lifecycleResultSchema = z.object({
  count: countComparisonSchema,
  stage: z.string(),
});

export const aiSdrWeeklyReportResultSchema = z.discriminatedUnion("success", [
  z.object({ error: z.string(), success: z.literal(false) }),
  z.object({
    campaignTypes: z.array(methodResultSchema),
    conversion: z.object({
      bookedMeetingRate: rateComparisonSchema,
      positiveReplyRate: rateComparisonSchema,
      replyRate: rateComparisonSchema,
    }),
    lifecycle: z.array(lifecycleResultSchema),
    lifecycleConversion: z.object({
      bookedPerSlotsSent: rateComparisonSchema,
      completedPerBooked: rateComparisonSchema,
      slotsSentPerReplied: rateComparisonSchema,
    }),
    success: z.literal(true),
    volume: z.object({
      bookedMeetings: countComparisonSchema,
      emailsSent: countComparisonSchema,
      positiveReplies: countComparisonSchema,
      replies: countComparisonSchema,
    }),
    windows: z.object({
      previous: windowSchema,
      report: windowSchema,
      sameWeekLastMonth: windowSchema,
    }),
  }),
]);

export type AiSdrWeeklyReportResult = z.infer<
  typeof aiSdrWeeklyReportResultSchema
>;
interface ThreeValues {
  previous: number;
  report: number;
  sameWeekLastMonth: number;
}

const percentChange = (current: number, baseline: number): number | null => {
  if (baseline === 0) {
    return current === 0 ? 0 : null;
  }
  return ((current - baseline) / baseline) * 100;
};

const countComparison = (values: ThreeValues) => ({
  ...values,
  momPercent: percentChange(values.report, values.sameWeekLastMonth),
  wowPercent: percentChange(values.report, values.previous),
});

const percentage = (numerator: number, denominator: number): number =>
  denominator > 0 ? (numerator / denominator) * 100 : 0;

const rateComparison = (numerator: ThreeValues, denominator: ThreeValues) => {
  const values = {
    previous: percentage(numerator.previous, denominator.previous),
    report: percentage(numerator.report, denominator.report),
    sameWeekLastMonth: percentage(
      numerator.sameWeekLastMonth,
      denominator.sameWeekLastMonth
    ),
  };
  return {
    ...values,
    momPercentagePoints: values.report - values.sameWeekLastMonth,
    wowPercentagePoints: values.report - values.previous,
  };
};

const sqlLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;
const timestampLiteral = (date: string): string =>
  `${sqlLiteral(`${date}T00:00:00Z`)}::timestamptz`;

const windowCounts = (
  field: string,
  window: ReportWindow,
  alias: string
): string =>
  `count(*) filter (where ${field} >= ${timestampLiteral(window.start)} and ${field} < ${timestampLiteral(window.endExclusive)}) as ${alias}`;

const windowSums = (
  field: string,
  dateField: string,
  window: ReportWindow,
  alias: string
): string =>
  `coalesce(sum(${field}) filter (where ${dateField} >= ${sqlLiteral(window.start)} and ${dateField} < ${sqlLiteral(window.endExclusive)}), 0) as ${alias}`;

/** The three fixed production queries used by the report tool. */
export function aiSdrWeeklyReportQueries(
  windows: AiSdrReportWindows
): string[] {
  const { report, previous, sameWeekLastMonth: month } = windows;
  return [
    [
      `select case when grouping(${NORMALIZED_CAMPAIGN_METHOD}) = 1 then '__total__' else coalesce(${NORMALIZED_CAMPAIGN_METHOD}, '__unclassified__') end as method,`,
      `${windowSums("m.emails_sent", "m.date", report, "report_sent")},`,
      `${windowSums("m.emails_sent", "m.date", previous, "previous_sent")},`,
      `${windowSums("m.emails_sent", "m.date", month, "month_sent")},`,
      `${windowSums("m.replies_received", "m.date", report, "report_replies")},`,
      `${windowSums("m.replies_received", "m.date", previous, "previous_replies")},`,
      `${windowSums("m.replies_received", "m.date", month, "month_replies")},`,
      `${windowSums("m.positive_replies", "m.date", report, "report_positive")},`,
      `${windowSums("m.positive_replies", "m.date", previous, "previous_positive")},`,
      windowSums("m.positive_replies", "m.date", month, "month_positive"),
      "from outreach_campaign_metrics m",
      "join outreach_campaign c on c.id = m.campaign_id",
      `where m.date >= ${sqlLiteral(month.start)} and m.date < ${sqlLiteral(report.endExclusive)}`,
      `group by grouping sets ((), (${NORMALIZED_CAMPAIGN_METHOD}))`,
      "order by method",
    ].join("\n"),
    [
      `select case when grouping(${NORMALIZED_CAMPAIGN_METHOD}) = 1 then '__total__' else coalesce(${NORMALIZED_CAMPAIGN_METHOD}, '__unclassified__') end as method,`,
      `${windowCounts("b.created_at", report, "report_booked")},`,
      `${windowCounts("b.created_at", previous, "previous_booked")},`,
      windowCounts("b.created_at", month, "month_booked"),
      "from scheduling_external_booking b",
      "join outreach_campaign c on c.id = b.campaign_id",
      "where b.deleted_at is null",
      "  and b.status = 'scheduled'",
      `  and b.created_at >= ${timestampLiteral(month.start)} and b.created_at < ${timestampLiteral(report.endExclusive)}`,
      `group by grouping sets ((), (${NORMALIZED_CAMPAIGN_METHOD}))`,
      "order by method",
    ].join("\n"),
    [
      "with transitions as (",
      "  select t.id as thread_id, event->>'to' as stage, (event->>'timestamp')::timestamptz as reached_at",
      "  from crm_message_thread t",
      "  cross join lateral jsonb_array_elements(t.lifecycle_history) event",
      "  where t.lifecycle_history is not null",
      "), first_arrival as (",
      "  select thread_id, stage, min(reached_at) as reached_at",
      "  from transitions",
      "  where stage in ('replied', 'slots_sent', 'booked', 'completed', 'declined', 'no_response')",
      "  group by thread_id, stage",
      ")",
      "select stage,",
      `  ${windowCounts("reached_at", report, "report")},`,
      `  ${windowCounts("reached_at", previous, "previous")},`,
      `  ${windowCounts("reached_at", month, "month")}`,
      "from first_arrival",
      "group by stage",
      "order by stage",
    ].join("\n"),
  ];
}

type MetricsRow = z.infer<typeof metricsRowSchema>;

const metricValues = (
  row: MetricsRow | undefined,
  metric: "positive" | "replies" | "sent"
): ThreeValues => ({
  previous: row?.[`previous_${metric}`] ?? 0,
  report: row?.[`report_${metric}`] ?? 0,
  sameWeekLastMonth: row?.[`month_${metric}`] ?? 0,
});

const bookingValues = (
  row: z.infer<typeof bookingRowSchema> | undefined
): ThreeValues => ({
  previous: row?.previous_booked ?? 0,
  report: row?.report_booked ?? 0,
  sameWeekLastMonth: row?.month_booked ?? 0,
});

const lifecycleValues = (
  row: z.infer<typeof lifecycleRowSchema> | undefined
): ThreeValues => ({
  previous: row?.previous ?? 0,
  report: row?.report ?? 0,
  sameWeekLastMonth: row?.month ?? 0,
});

/** Runs the fixed reads sequentially and calculates the complete typed report. */
export async function readAiSdrWeeklyReport(
  now: Date,
  run: (query: string) => Promise<string>
): Promise<AiSdrWeeklyReportResult> {
  try {
    const windows = aiSdrReportWindows(now);
    const [metricsQuery, bookingsQuery, lifecycleQuery] =
      aiSdrWeeklyReportQueries(windows);
    if (!(metricsQuery && bookingsQuery && lifecycleQuery)) {
      throw new Error("AI SDR report query construction failed.");
    }

    // PlanetScale MCP sessions are opened per query and reject overlapping
    // handshakes intermittently, so these three independent reads stay serial.
    const metricsRows = parseReadQueryResult(await run(metricsQuery)).rows.map(
      (row) => metricsRowSchema.parse(row)
    );
    const bookingRows = parseReadQueryResult(await run(bookingsQuery)).rows.map(
      (row) => bookingRowSchema.parse(row)
    );
    const lifecycleRows = parseReadQueryResult(
      await run(lifecycleQuery)
    ).rows.map((row) => lifecycleRowSchema.parse(row));

    const metricsByMethod = new Map(
      metricsRows.map((row) => [row.method, row])
    );
    const bookingsByMethod = new Map(
      bookingRows.map((row) => [row.method, row])
    );
    const lifecycleByStage = new Map(
      lifecycleRows.map((row) => [row.stage, row])
    );
    const totalMetrics = metricsByMethod.get(TOTAL);
    const totalBookings = bookingsByMethod.get(TOTAL);
    if (!(totalMetrics && totalBookings)) {
      throw new Error("AI SDR aggregate queries returned no total row.");
    }

    const sent = metricValues(totalMetrics, "sent");
    const replies = metricValues(totalMetrics, "replies");
    const positive = metricValues(totalMetrics, "positive");
    const booked = bookingValues(totalBookings);
    const stages = Object.fromEntries(
      LIFECYCLE_STAGES.map((stage) => [
        stage,
        lifecycleValues(lifecycleByStage.get(stage)),
      ])
    ) as Record<(typeof LIFECYCLE_STAGES)[number], ThreeValues>;

    return {
      campaignTypes: CAMPAIGN_METHODS.map((method) => {
        const methodPositive = metricValues(
          metricsByMethod.get(method),
          "positive"
        );
        const methodBooked = bookingValues(bookingsByMethod.get(method));
        return {
          bookedMeetingRate: rateComparison(methodBooked, methodPositive),
          bookedMeetings: countComparison(methodBooked),
          method,
          positiveReplies: countComparison(methodPositive),
        };
      }),
      conversion: {
        bookedMeetingRate: rateComparison(booked, positive),
        positiveReplyRate: rateComparison(positive, replies),
        replyRate: rateComparison(replies, sent),
      },
      lifecycle: LIFECYCLE_STAGES.map((stage) => ({
        count: countComparison(stages[stage]),
        stage,
      })),
      lifecycleConversion: {
        bookedPerSlotsSent: rateComparison(stages.booked, stages.slots_sent),
        completedPerBooked: rateComparison(stages.completed, stages.booked),
        slotsSentPerReplied: rateComparison(stages.slots_sent, stages.replied),
      },
      success: true,
      volume: {
        bookedMeetings: countComparison(booked),
        emailsSent: countComparison(sent),
        positiveReplies: countComparison(positive),
        replies: countComparison(replies),
      },
      windows,
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "The AI SDR report could not be generated.",
      success: false,
    };
  }
}
