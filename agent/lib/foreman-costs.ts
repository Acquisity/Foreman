import type { ProviderClient } from "./executor/operations.js";

/**
 * Foreman's daily running-cost report.
 *
 * @remarks
 * Two sources, because Vercel bills them apart:
 *
 * - Platform usage (sandbox, workflow, functions, storage, queues) comes from
 *   the FOCUS billing export through the `vercel.billingCharges` Executor
 *   helper, filtered to the Foreman project by the `Tags.ProjectId` each row
 *   carries.
 * - Model spend comes from the AI Gateway spend report, which is team-wide
 *   and not part of the FOCUS export. Every gateway key on the team is
 *   Foreman's, so the team figure is Foreman's figure. Claude models run on
 *   the CLI Proxy and are not in it.
 *
 * The report day is yesterday in UTC, the last day both sources have closed.
 * FOCUS rows are Pacific calendar days keyed by `ChargePeriodStart`, so the
 * date prefix of that field is the day label; today's partial row is dropped.
 */

/** The Foreman project and the team that owns it, as billed. */
export const FOREMAN_PROJECT_ID = "prj_zeRzl67zpLpS6pXjscNusD3Gc307";
export const VERCEL_TEAM_ID = "team_ZU8UTsvGgsLZaLDc8pUAzict";

/** Days before the report day that make the comparison average. */
export const COMPARISON_DAYS = 7;

/** Lines named individually before the rest collapses into "other". */
const TOP_LINES = 5;

/** Eight days of team-wide FOCUS rows were about 4.5 MB; the wire body adds JSON escaping. */
const MAX_WIRE_BYTES = 32 * 1024 * 1024;

/** Paid sources the report cannot read, named so the total is not mistaken for everything. */
export const NOT_TRACKED =
  "Not tracked: Neon (Foreman memory and support Postgres), CLI Proxy on Railway (Claude models), GitHub Actions CI";

const DAY_MS = 24 * 60 * 60 * 1000;

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface CostWindow {
  /** First day of the comparison range, inclusive (YYYY-MM-DD). */
  firstDay: string;
  /** Inclusive start of the charges query. */
  from: string;
  /** The day being reported, yesterday in UTC (YYYY-MM-DD). */
  reportDay: string;
  /** Exclusive end of the charges query: now, so today's partial day is fetched and dropped by label. */
  to: string;
}

/** The report day plus the comparison days before it. */
export const costWindow = (now: number): CostWindow => {
  const today = Date.parse(`${dayOf(now)}T00:00:00.000Z`);
  const reportDay = dayOf(today - DAY_MS);
  const firstDay = dayOf(today - (COMPARISON_DAYS + 1) * DAY_MS);
  return {
    firstDay,
    from: `${firstDay}T00:00:00.000Z`,
    reportDay,
    to: new Date(now).toISOString(),
  };
};

export interface CostLine {
  cost: number;
  name: string;
}

export interface SourceSummary {
  /** Mean daily cost over the comparison days that had any data. */
  averageCost: number | null;
  /** Report-day cost, or null when the source has no row for that day. */
  cost: number | null;
  /** Report-day cost by line, largest first, the tail folded into "other". */
  lines: CostLine[];
}

/** Reads the team's FOCUS export over the window; the body is JSONL text or already-parsed rows. */
export const readVercelCharges = async (
  client: ProviderClient,
  window: CostWindow,
  signal: AbortSignal
): Promise<unknown> => {
  const { data, status } = await client(
    {
      input: { from: window.from, teamId: VERCEL_TEAM_ID, to: window.to },
      operation: "vercel.billingCharges",
    },
    { signal, wireMaxBytes: MAX_WIRE_BYTES }
  );
  if (status < 200 || status >= 300) {
    throw new Error(`Vercel billing responded HTTP ${status}.`);
  }
  return data;
};

const parseLine = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const focusRows = (data: unknown): unknown[] => {
  if (Array.isArray(data)) {
    return data;
  }
  return typeof data === "string" ? data.split("\n").map(parseLine) : [];
};

interface FocusRow {
  ChargePeriodStart: string;
  EffectiveCost: number;
  ServiceName: string;
  Tags?: { ProjectId?: string };
}

const isFocusRow = (value: unknown): value is FocusRow =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as FocusRow).ChargePeriodStart === "string" &&
  typeof (value as FocusRow).EffectiveCost === "number" &&
  typeof (value as FocusRow).ServiceName === "string";

/** Report-day and comparison figures for one project out of the team's FOCUS export. */
export const summarizeVercelCharges = (
  data: unknown,
  window: CostWindow,
  projectId = FOREMAN_PROJECT_ID
): SourceSummary => {
  const byDay = new Map<string, number>();
  const services = new Map<string, number>();
  for (const row of focusRows(data)) {
    if (!isFocusRow(row) || row.Tags?.ProjectId !== projectId) {
      continue;
    }
    const day = row.ChargePeriodStart.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + row.EffectiveCost);
    if (day === window.reportDay) {
      services.set(
        row.ServiceName,
        (services.get(row.ServiceName) ?? 0) + row.EffectiveCost
      );
    }
  }
  return summarizeDays(byDay, services, window);
};

/** One spend-report row, as the AI Gateway provider returns it. */
export interface GatewaySpendRow {
  day?: string;
  model?: string;
  totalCost: number;
}

/** Report-day and comparison figures from two gateway spend reports. */
export const summarizeGatewaySpend = (
  byDayRows: GatewaySpendRow[],
  byModelRows: GatewaySpendRow[],
  window: CostWindow
): SourceSummary => {
  const byDay = new Map<string, number>();
  for (const row of byDayRows) {
    if (row.day) {
      byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.totalCost);
    }
  }
  const models = new Map<string, number>();
  for (const row of byModelRows) {
    if (row.model) {
      models.set(row.model, (models.get(row.model) ?? 0) + row.totalCost);
    }
  }
  return summarizeDays(byDay, models, window);
};

const summarizeDays = (
  byDay: Map<string, number>,
  lines: Map<string, number>,
  window: CostWindow
): SourceSummary => {
  const comparison = [...byDay].filter(
    ([day]) => day >= window.firstDay && day < window.reportDay
  );
  const averageCost =
    comparison.length === 0
      ? null
      : comparison.reduce((sum, [, cost]) => sum + cost, 0) / comparison.length;
  const sorted = [...lines]
    .map(([name, cost]) => ({ cost, name }))
    .sort((a, b) => b.cost - a.cost);
  const top = sorted.slice(0, TOP_LINES);
  const rest = sorted.slice(TOP_LINES).reduce((sum, { cost }) => sum + cost, 0);
  if (rest > 0) {
    top.push({ cost: rest, name: "other" });
  }
  return {
    averageCost,
    cost: byDay.get(window.reportDay) ?? null,
    lines: top,
  };
};

export interface CostReport {
  credits: { balance: number; totalUsed: number } | { error: string };
  gateway: SourceSummary | { error: string };
  reportDay: string;
  vercel: SourceSummary | { error: string };
}

const usd = (value: number): string =>
  `$${value.toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;

const delta = (cost: number, average: number | null): string => {
  if (average === null) {
    return "no comparison yet";
  }
  if (average === 0) {
    return `${COMPARISON_DAYS}-day avg ${usd(0)}`;
  }
  const pct = Math.round(((cost - average) / average) * 100);
  const sign = pct > 0 ? "+" : "";
  return `${COMPARISON_DAYS}-day avg ${usd(average)}, ${sign}${pct}%`;
};

const sourceLine = (
  label: string,
  summary: SourceSummary | { error: string }
): string => {
  if ("error" in summary) {
    return `${label}: unavailable (${summary.error})`;
  }
  if (summary.cost === null) {
    return `${label}: no charges recorded yet`;
  }
  const lines = summary.lines
    .map(({ name, cost }) => `${name} ${usd(cost)}`)
    .join(" · ");
  return `${label}: ${usd(summary.cost)} (${delta(summary.cost, summary.averageCost)})${lines ? `; ${lines}` : ""}`;
};

/** The Slack message, rendered here so the model posts it unchanged. */
export const renderCostReport = (report: CostReport): string => {
  const parts = [report.gateway, report.vercel].filter(
    (source): source is SourceSummary => !("error" in source)
  );
  const total = parts.reduce((sum, { cost }) => sum + (cost ?? 0), 0);
  const averages = parts.map(({ averageCost }) => averageCost);
  const average =
    averages.length === 0 || averages.some((value) => value === null)
      ? null
      : averages.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const lines = [
    `*Foreman running costs for ${report.reportDay}* (USD)`,
    parts.length === 0
      ? "Total: unavailable"
      : `Total: ${usd(total)} (${delta(total, average)})${parts.length === 1 ? ", one source missing" : ""}`,
    sourceLine("AI Gateway", report.gateway),
    sourceLine("Vercel platform", report.vercel),
  ];
  if ("error" in report.credits) {
    lines.push(`AI Gateway credits: unavailable (${report.credits.error})`);
  } else {
    const gatewayAverage =
      "error" in report.gateway ? null : report.gateway.averageCost;
    const runway =
      gatewayAverage && gatewayAverage > 0
        ? `, about ${Math.floor(report.credits.balance / gatewayAverage)} days at the ${COMPARISON_DAYS}-day average`
        : "";
    lines.push(
      `AI Gateway credits left: ${usd(report.credits.balance)}${runway}`
    );
  }
  lines.push(NOT_TRACKED);
  return lines.join("\n");
};
