import type { AiSdrWeeklyReportResult } from "./ai-sdr-weekly-report.js";

type Report = Extract<AiSdrWeeklyReportResult, { success: true }>;
type Count = Report["volume"]["emailsSent"];
type Rate = Report["conversion"]["replyRate"];
type ThreeWeeks = Pick<Count, "previous" | "report" | "sameWeekLastMonth">;

const METHOD_LABELS: Record<string, string> = {
  direct: "Direct",
  interview: "Interview",
  "lead-magnet": "Lead-magnet",
  podcast: "Podcast",
};
const STAGE_LABELS: Record<string, string> = {
  booked: "Booked",
  completed: "Completed",
  declined: "Declined",
  no_response: "No response",
  replied: "Replied",
  slots_sent: "Slots sent",
};
const HEADER_ROW = [
  "Metric",
  "This wk",
  "Last wk",
  "Δ WoW",
  "Same wk last month",
  "Δ MoM",
];
const SERIES = [
  ["This wk", "report"],
  ["Last wk", "previous"],
  ["Same wk last month", "sameWeekLastMonth"],
] as const;

const count = (value: number): string => {
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  return Math.round(value).toLocaleString("en-US");
};
const signed = (value: number, digits: number, unit: string): string =>
  `${value >= 0 ? "+" : ""}${value.toFixed(digits)}${unit}`;
const countDelta = (value: number | null): string =>
  value === null ? "n/a" : signed(value, 1, "%");

const countRow = (label: string, value: Count): string[] => [
  label,
  count(value.report),
  count(value.previous),
  countDelta(value.wowPercent),
  count(value.sameWeekLastMonth),
  countDelta(value.momPercent),
];
const rateRow = (label: string, value: Rate, digits = 1): string[] => [
  label,
  `${value.report.toFixed(digits)}%`,
  `${value.previous.toFixed(digits)}%`,
  signed(value.wowPercentagePoints, digits, "pp"),
  `${value.sameWeekLastMonth.toFixed(digits)}%`,
  signed(value.momPercentagePoints, digits, "pp"),
];

const mrkdwn = (text: string) => ({ text, type: "mrkdwn" });
const section = (text: string) => ({ text: mrkdwn(text), type: "section" });
const context = (text: string) => ({
  elements: [mrkdwn(text)],
  type: "context",
});
const table = (rows: string[][]) => ({
  column_settings: [
    { is_wrapped: true },
    ...HEADER_ROW.slice(1).map(() => ({ align: "right", is_wrapped: true })),
  ],
  rows: [HEADER_ROW, ...rows].map((row) =>
    row.map((text) => ({ text, type: "raw_text" }))
  ),
  type: "table",
});
const barChart = (
  title: string,
  yLabel: string,
  points: { label: string; value: ThreeWeeks }[]
) => {
  const categories = points.map(({ label }) => label);
  return {
    chart: {
      axis_config: { categories, y_label: yLabel },
      series: SERIES.map(([name, key]) => ({
        data: points.map(({ label, value }) => ({
          label,
          value: Number(value[key].toFixed(2)),
        })),
        name,
      })),
      type: "bar",
    },
    title,
    type: "data_visualization",
  };
};

const day = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  });
const reportWindow = ({ start, end }: Report["windows"]["report"]): string => {
  const [startDay, startMonth, startYear] = day(start).split(" ");
  const endLabel = day(end);
  if (`${startMonth} ${startYear}` === endLabel.split(" ").slice(1).join(" ")) {
    return `${startDay} to ${endLabel}`;
  }
  return `${day(start)} to ${endLabel}`;
};

/** One table as readable lines, because screen readers read only the message text. */
const textSection = (heading: string, rows: string[][]): string =>
  [
    `${heading}:`,
    ...rows.map(
      ([label, thisWeek, lastWeek, wow, lastMonth, mom]) =>
        `${label}: ${thisWeek} this week, ${lastWeek} last week (${wow}), ${lastMonth} same week last month (${mom}).`
    ),
  ].join("\n");

/**
 * The weekly AI SDR report as Slack blocks: native bar charts and tables,
 * rendered in code so every figure is the report's own. The message text
 * carries the same rows as lines, for screen readers. The model's written
 * summary goes in the thread under this message.
 */
export const renderAiSdrReportBlocks = (
  report: Report
): { blocks: unknown[]; text: string } => {
  const { conversion, volume, lifecycleConversion } = report;
  const title = `AI SDR weekly report, ${reportWindow(report.windows.report)}`;
  const booked = volume.bookedMeetings;
  const headline =
    `*${count(booked.report)} booked meetings*, ${countDelta(booked.wowPercent)} on last week and ${countDelta(booked.momPercent)} on the same week last month.\n` +
    `Booked meeting rate ${conversion.bookedMeetingRate.report.toFixed(1)}% of positive replies (${signed(conversion.bookedMeetingRate.wowPercentagePoints, 1, "pp")} on last week).`;
  const methods = report.campaignTypes.map((method) => ({
    label: METHOD_LABELS[method.method] ?? method.method,
    value: method.bookedMeetingRate,
  }));
  const stages = report.lifecycle.map((stage) => ({
    label: STAGE_LABELS[stage.stage] ?? stage.stage,
    value: stage.count,
  }));
  const volumeRows = [
    countRow("Emails sent", volume.emailsSent),
    countRow("Replies", volume.replies),
    countRow("Positive replies", volume.positiveReplies),
    countRow("Booked meetings", volume.bookedMeetings),
    countRow("Cancelled or declined since", volume.lostMeetings),
    rateRow("Reply rate", conversion.replyRate, 2),
    rateRow("Positive reply rate", conversion.positiveReplyRate),
    rateRow("Booked meeting rate", conversion.bookedMeetingRate),
  ];
  const methodRows = methods.map(({ label, value }) => rateRow(label, value));
  const lifecycleRows = [
    ...stages.map(({ label, value }) => countRow(label, value)),
    rateRow("Slots sent / replied", lifecycleConversion.slotsSentPerReplied),
    rateRow("Booked / slots sent", lifecycleConversion.bookedPerSlotsSent),
    rateRow("Completed / booked", lifecycleConversion.completedPerBooked),
  ];
  return {
    blocks: [
      { text: { text: title, type: "plain_text" }, type: "header" },
      section(headline),
      section("*Volume and conversion*"),
      table(volumeRows),
      context(
        "Booked meetings count every AI SDR booking made in the week, once per guest, including ones cancelled or declined since. Booked meeting rate is booked meetings over positive replies."
      ),
      section("*Booked meeting rate by campaign type*"),
      barChart(
        "Booked meeting rate by campaign type",
        "% of positive replies",
        methods
      ),
      table(methodRows),
      context("Remaining types are too small to read a trend from."),
      section("*AI SDR lifecycle, every stage*"),
      barChart("AI SDR lifecycle, every stage", "Leads", stages),
      table(lifecycleRows),
      context(
        "Completed lags because a meeting only completes after its date, so recent weeks fill in late. The summary is in the thread."
      ),
    ],
    text: [
      `${title}. ${headline.replaceAll("*", "")}`,
      textSection("Volume and conversion", volumeRows),
      textSection("Booked meeting rate by campaign type", methodRows),
      textSection("AI SDR lifecycle", lifecycleRows),
    ].join("\n\n"),
  };
};
