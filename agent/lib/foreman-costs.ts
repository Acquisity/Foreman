import { createGateway } from "ai";
import type { ProviderClient } from "./executor/operations.js";
import { ExecutorError } from "./executor/transport.js";

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
const UNTRACKED =
  "Neon (Foreman memory and support Postgres), CLI Proxy on Railway (Claude models), GitHub Actions CI";
export const NOT_TRACKED = `Not tracked: ${UNTRACKED}`;

const DAY_MS = 24 * 60 * 60 * 1000;

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface CostWindow {
  /** First day of the comparison range, inclusive (YYYY-MM-DD). */
  firstDay: string;
  /** The day being reported, yesterday in UTC (YYYY-MM-DD). */
  reportDay: string;
}

/** The report day plus the comparison days before it. */
export const costWindow = (now: number): CostWindow => {
  const today = Date.parse(`${dayOf(now)}T00:00:00.000Z`);
  const reportDay = dayOf(today - DAY_MS);
  const firstDay = dayOf(today - (COMPARISON_DAYS + 1) * DAY_MS);
  return {
    firstDay,
    reportDay,
  };
};

export interface CostLine {
  cost: number;
  name: string;
}

export interface SourceSummary {
  /** Mean daily cost over all seven calendar days in the comparison window. */
  averageCost: number | null;
  /** Report-day cost, or null when the source has no row for that day. */
  cost: number | null;
  /** Report-day cost by line, largest first, the tail folded into "other". */
  lines: CostLine[];
}

type CostSourceReason =
  | "unreadable billing export"
  | "unreadable credit balance"
  | `HTTP ${number}`;

export class CostSourceError extends Error {
  readonly reason: CostSourceReason;

  constructor(reason: CostSourceReason) {
    super(reason);
    this.reason = reason;
  }
}

/** Pacific midnight in UTC, including the offset in force at midnight on DST-change days. */
const pacificMidnight = (day: string): string => {
  const midnight = Date.parse(`${day}T00:00:00.000Z`);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "shortOffset",
  });
  let candidate = midnight + 8 * 60 * 60 * 1000;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const offset = formatter
      .formatToParts(candidate)
      .find((part) => part.type === "timeZoneName")?.value;
    const hours = Number(offset?.replace("GMT", ""));
    candidate = midnight - hours * 60 * 60 * 1000;
  }
  return new Date(candidate).toISOString();
};

/** Exact Pacific windows prevent FOCUS storage proration from changing the headline cost. */
export const readVercelCharges = async (
  client: ProviderClient,
  window: CostWindow,
  signal: AbortSignal
): Promise<SourceSummary> => {
  const read = async (from: string, to: string): Promise<SourceSummary> => {
    const { data, status } = await client(
      {
        input: { from, teamId: VERCEL_TEAM_ID, to },
        operation: "vercel.billingCharges",
      },
      { signal, wireMaxBytes: MAX_WIRE_BYTES }
    );
    if (status < 200 || status >= 300) {
      throw new CostSourceError(`HTTP ${status}`);
    }
    return summarizeVercelCharges(data, window);
  };
  const boundary = pacificMidnight(window.reportDay);
  const nextDay = dayOf(
    Date.parse(`${window.reportDay}T00:00:00.000Z`) + DAY_MS
  );
  const [report, comparison] = await Promise.all([
    read(boundary, pacificMidnight(nextDay)),
    read(pacificMidnight(window.firstDay), boundary),
  ]);
  return { ...report, averageCost: comparison.averageCost };
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
  if (typeof data === "string") {
    return data
      .split("\n")
      .filter((line) => line.trim())
      .map(parseLine);
  }
  throw new CostSourceError("unreadable billing export");
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
  Number.isFinite((value as FocusRow).EffectiveCost) &&
  typeof (value as FocusRow).ServiceName === "string";

/** Report-day and comparison figures for one project out of the team's FOCUS export. */
export const summarizeVercelCharges = (
  data: unknown,
  window: CostWindow,
  projectId = FOREMAN_PROJECT_ID
): SourceSummary => {
  const byDay = new Map<string, number>();
  const services = new Map<string, number>();
  const rows = focusRows(data);
  if (rows.length > 0 && !rows.some(isFocusRow)) {
    throw new CostSourceError("unreadable billing export");
  }
  for (const row of rows) {
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
    comparison.reduce((sum, [, cost]) => sum + cost, 0) / COMPARISON_DAYS;
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
  credits: { balance: number } | { error: string };
  gateway: SourceSummary | { error: string };
  reportDay: string;
  vercel: SourceSummary | { error: string };
}

/** A failure's reason from fixed names, application-owned codes and numeric statuses only, never provider messages or bodies. */
export const failureReason = (error: unknown, fallback: string): string => {
  // SDK errors wrap HTTP and deadline failures in causes.
  let cause = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (cause instanceof CostSourceError) {
      return cause.reason;
    }
    if (cause instanceof ExecutorError) {
      return cause.code;
    }
    if (typeof cause !== "object" || cause === null) {
      break;
    }
    const failure = cause as {
      name?: unknown;
      statusCode?: unknown;
      status?: unknown;
      cause?: unknown;
    };
    if (failure.name === "TimeoutError" || failure.name === "AbortError") {
      return "timed out";
    }
    const status = failure.statusCode ?? failure.status;
    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
    ) {
      return `HTTP ${status}`;
    }
    ({ cause } = failure);
  }
  return fallback;
};

const settle = async <T>(
  work: () => Promise<T>,
  fallback: string,
  signal: AbortSignal
): Promise<T | { error: string }> => {
  try {
    return await work();
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    console.error(fallback);
    return { error: failureReason(error, fallback) };
  }
};

/** Per-request deadline for the gateway spend and credit reads. */
const GATEWAY_TIMEOUT_MS = 20_000;

/** The gateway provider with standard auth (AI_GATEWAY_API_KEY, else deployment OIDC), with every request bounded and cancellable. */
const boundedGateway = (signal: AbortSignal) =>
  createGateway({
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
        ]),
      }),
  });

/** Every source read in parallel; each fails into its own error while cancellation still throws. */
export const readCostReport = async (
  client: ProviderClient,
  signal: AbortSignal,
  now = Date.now()
): Promise<CostReport> => {
  const window = costWindow(now);
  const gateway = boundedGateway(signal);
  const [vercel, gatewaySpend, credits] = await Promise.all([
    settle<SourceSummary>(
      async () => readVercelCharges(client, window, signal),
      "Vercel billing read could not run.",
      signal
    ),
    settle<SourceSummary>(
      async () => {
        const [byDay, byModel] = await Promise.all([
          gateway.getSpendReport({
            endDate: window.reportDay,
            groupBy: "day",
            startDate: window.firstDay,
          }),
          gateway.getSpendReport({
            endDate: window.reportDay,
            groupBy: "model",
            startDate: window.reportDay,
          }),
        ]);
        return summarizeGatewaySpend(byDay.results, byModel.results, window);
      },
      "AI Gateway spend read could not run.",
      signal
    ),
    settle(
      async () => {
        const raw = String((await gateway.getCredits()).balance).trim();
        const balance = Number(raw);
        if (raw === "" || !Number.isFinite(balance)) {
          throw new CostSourceError("unreadable credit balance");
        }
        return { balance };
      },
      "AI Gateway credits read could not run.",
      signal
    ),
  ]);
  return {
    credits,
    gateway: gatewaySpend,
    reportDay: window.reportDay,
    vercel,
  };
};

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

type Source = SourceSummary | { error: string };

/** Why a source has no report-day figure, or null when it has one. */
const unavailable = (summary: Source, reportDay: string): string | null => {
  if ("error" in summary) {
    return summary.error;
  }
  return summary.cost === null ? `no rows for ${reportDay} yet` : null;
};

const sourceCost = (summary: SourceSummary & { cost: number }): string =>
  `${usd(summary.cost)} (${delta(summary.cost, summary.averageCost)})`;

const lineList = (lines: CostLine[]): string =>
  lines.map(({ name, cost }) => `${name} ${usd(cost)}`).join(" · ");

const isPriced = (source: Source): source is SourceSummary & { cost: number } =>
  !("error" in source) && source.cost !== null;

/** The combined figure, or null when neither source has one. */
const total = (
  report: CostReport
): { partial: boolean; value: string } | null => {
  const parts = [report.gateway, report.vercel].filter(isPriced);
  if (parts.length === 0) {
    return null;
  }
  const sum = parts.reduce((acc, { cost }) => acc + cost, 0);
  const averages = parts.map(({ averageCost }) => averageCost);
  const average = averages.some((value) => value === null)
    ? null
    : averages.reduce<number>((acc, value) => acc + (value ?? 0), 0);
  return {
    partial: parts.length === 1,
    value: `${usd(sum)} (${delta(sum, average)})`,
  };
};

/** Credit balance with runway at the gateway's comparison average. */
const creditsLeft = (report: CostReport, balance: number): string => {
  const gatewayAverage =
    "error" in report.gateway ? null : report.gateway.averageCost;
  const runway =
    gatewayAverage && gatewayAverage > 0
      ? `, about ${Math.floor(balance / gatewayAverage)} days at the ${COMPARISON_DAYS}-day average`
      : "";
  return `${usd(balance)}${runway}`;
};

const sourceLine = (
  label: string,
  summary: Source,
  reportDay: string
): string => {
  const missing = unavailable(summary, reportDay);
  if (missing !== null || !isPriced(summary)) {
    return `${label}: unavailable (${missing})`;
  }
  const lines = lineList(summary.lines);
  return `${label}: ${sourceCost(summary)}${lines ? `; ${lines}` : ""}`;
};

/** The plain-text report the tool returns for attended asks. */
export const renderCostReport = (report: CostReport): string => {
  const sum = total(report);
  return [
    `*Foreman running costs for ${report.reportDay}* (USD)`,
    sum
      ? `Total${sum.partial ? " (partial)" : ""}: ${sum.value}`
      : "Total: unavailable",
    sourceLine("AI Gateway", report.gateway, report.reportDay),
    sourceLine("Vercel platform", report.vercel, report.reportDay),
    "error" in report.credits
      ? `AI Gateway credits: unavailable (${report.credits.error})`
      : `AI Gateway credits left: ${creditsLeft(report, report.credits.balance)}`,
    NOT_TRACKED,
  ].join("\n");
};

/** Lines named per source in the Slack message. */
const SLACK_LINES = 3;

/** Where the message links: the team's Vercel usage page. */
const USAGE_URL = "https://vercel.com/acquisity/~/usage";

/** "Sunday, Oct 11" for a YYYY-MM-DD report day. */
const longDay = (day: string): string =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    weekday: "long",
  });

/** "▲ 27% vs 7-day avg $11.47", or a note when there is no comparison. */
const trend = (cost: number, average: number | null): string => {
  if (average === null) {
    return "no 7-day comparison yet";
  }
  if (average === 0) {
    return `7-day avg ${usd(0)}`;
  }
  const pct = Math.round(((cost - average) / average) * 100);
  if (pct === 0) {
    return `even with ${COMPARISON_DAYS}-day avg ${usd(average)}`;
  }
  return `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs ${COMPARISON_DAYS}-day avg ${usd(average)}`;
};

const mrkdwn = (text: string) => ({ text, type: "mrkdwn" });

/** One section per source: figure and trend, then its top lines. */
const sourceBlock = (label: string, summary: Source, reportDay: string) => {
  if (!isPriced(summary)) {
    return {
      text: mrkdwn(
        `*${label}*   unavailable\n_${unavailable(summary, reportDay)}_`
      ),
      type: "section",
    };
  }
  const lines = summary.lines
    .filter(({ name }) => name !== "other")
    .slice(0, SLACK_LINES)
    .map(({ name, cost }) => `•  ${name}   ${usd(cost)}`);
  return {
    text: mrkdwn(
      [
        `*${label}*   ${usd(summary.cost)}   _${trend(summary.cost, summary.averageCost)}_`,
        ...lines,
      ].join("\n")
    ),
    type: "section",
  };
};

/**
 * The daily Slack message as Block Kit: a header, the day's total, one
 * section per source, credits, and a footer naming what is not tracked.
 * `text` is the notification and accessibility fallback.
 */
export const renderCostBlocks = (
  report: CostReport
): { blocks: unknown[]; text: string } => {
  const parts = [report.gateway, report.vercel].filter(isPriced);
  const sum = parts.reduce((acc, { cost }) => acc + cost, 0);
  const averages = parts.map(({ averageCost }) => averageCost);
  const average = averages.includes(null)
    ? null
    : averages.reduce<number>((acc, value) => acc + (value ?? 0), 0);
  const headline =
    parts.length === 0
      ? "*Total unavailable*"
      : `*${usd(sum)}* total   ${trend(sum, average)}${parts.length === 1 ? "   (partial: one source unavailable)" : ""}`;
  const credits =
    "error" in report.credits
      ? `*AI Gateway credits*   unavailable\n_${report.credits.error}_`
      : `*AI Gateway credits*   ${creditsLeft(report, report.credits.balance)}`;
  return {
    blocks: [
      {
        text: {
          text: `Foreman running costs · ${longDay(report.reportDay)}`,
          type: "plain_text",
        },
        type: "header",
      },
      { text: mrkdwn(headline), type: "section" },
      { type: "divider" },
      sourceBlock("AI Gateway", report.gateway, report.reportDay),
      sourceBlock("Vercel platform", report.vercel, report.reportDay),
      { text: mrkdwn(credits), type: "section" },
      {
        elements: [
          mrkdwn(
            `${report.reportDay} (USD)  ·  Not tracked: ${UNTRACKED}  ·  <${USAGE_URL}|Vercel usage>`
          ),
        ],
        type: "context",
      },
    ],
    text: `Foreman running costs for ${report.reportDay}: ${parts.length === 0 ? "unavailable" : `${usd(sum)} (${trend(sum, average)})`}`,
  };
};
