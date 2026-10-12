import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderClient } from "./executor/operations.js";
import {
  COMPARISON_DAYS,
  costWindow,
  FOREMAN_PROJECT_ID,
  NOT_TRACKED,
  readVercelCharges,
  renderCostReport,
  summarizeGatewaySpend,
  summarizeVercelCharges,
  VERCEL_TEAM_ID,
} from "./foreman-costs.js";

/** 13:00 UTC on 2026-08-28, the production tick. */
const NOW = Date.parse("2026-08-28T13:00:00.000Z");
const WINDOW = costWindow(NOW);
const REFUSED = /Vercel billing responded HTTP 404/u;
const TOTAL_WITHOUT_COMPARISON = /^Total: \$35\.00 \(no comparison yet\)$/mu;
const GATEWAY_WITH_COMPARISON =
  /^AI Gateway: \$30\.00 \(7-day avg \$20\.00, \+50%\)$/mu;

const focus = (
  day: string,
  service: string,
  cost: number,
  projectId = FOREMAN_PROJECT_ID
): string =>
  JSON.stringify({
    ChargePeriodStart: `${day}T07:00:00.000Z`,
    EffectiveCost: cost,
    ServiceName: service,
    Tags: { ProjectId: projectId, ProjectName: "x" },
  });

describe("cost window", () => {
  it("reports yesterday in UTC with seven comparison days before it", () => {
    assert.deepEqual(WINDOW, {
      firstDay: "2026-08-20",
      from: "2026-08-20T00:00:00.000Z",
      reportDay: "2026-08-27",
      to: "2026-08-28T13:00:00.000Z",
    });
    assert.equal(COMPARISON_DAYS, 7);
  });

  it("stays on UTC days across the Pacific daylight-saving change", () => {
    const window = costWindow(Date.parse("2026-11-02T13:00:00.000Z"));
    assert.equal(window.reportDay, "2026-11-01");
    assert.equal(window.firstDay, "2026-10-25");
    // The Pacific day of the change starts at 07:00Z and is labeled by that date.
    const data = [
      JSON.stringify({
        ChargePeriodStart: "2026-11-01T07:00:00.000Z",
        EffectiveCost: 2,
        ServiceName: "Functions",
        Tags: { ProjectId: FOREMAN_PROJECT_ID },
      }),
      JSON.stringify({
        ChargePeriodStart: "2026-11-02T08:00:00.000Z",
        EffectiveCost: 50,
        ServiceName: "Functions",
        Tags: { ProjectId: FOREMAN_PROJECT_ID },
      }),
    ].join("\n");
    assert.equal(summarizeVercelCharges(data, window).cost, 2);
  });
});

describe("Vercel charges", () => {
  it("reads the team's export over the window through Executor", async () => {
    const calls: unknown[] = [];
    const client: ProviderClient = (request, options) => {
      calls.push({ options, request });
      return Promise.resolve({ data: "{}\n", status: 200 });
    };
    const { signal } = new AbortController();
    assert.equal(await readVercelCharges(client, WINDOW, signal), "{}\n");
    assert.deepEqual(calls, [
      {
        options: { signal, wireMaxBytes: 32 * 1024 * 1024 },
        request: {
          input: { from: WINDOW.from, teamId: VERCEL_TEAM_ID, to: WINDOW.to },
          operation: "vercel.billingCharges",
        },
      },
    ]);
  });

  it("names the status when the export is refused", async () => {
    const client: ProviderClient = () =>
      Promise.resolve({ data: null, status: 404 });
    await assert.rejects(
      readVercelCharges(client, WINDOW, new AbortController().signal),
      REFUSED
    );
  });

  it("keeps only the project, labels days by period start, drops today", () => {
    const jsonl = [
      focus("2026-08-27", "Sandbox Provisioned Memory", 4),
      focus("2026-08-27", "Snapshot Storage", 6),
      focus("2026-08-27", "Snapshot Storage", 1),
      focus("2026-08-27", "Other Project Thing", 99, "prj_other"),
      focus("2026-08-26", "Snapshot Storage", 5),
      focus("2026-08-20", "Snapshot Storage", 3),
      focus("2026-08-19", "Snapshot Storage", 1000),
      focus("2026-08-28", "Snapshot Storage", 1000),
      "",
      "{not json",
      JSON.stringify({ unrelated: true }),
    ].join("\n");
    const summary = summarizeVercelCharges(jsonl, WINDOW);
    assert.deepEqual(summary, {
      averageCost: 4,
      cost: 11,
      lines: [
        { cost: 7, name: "Snapshot Storage" },
        { cost: 4, name: "Sandbox Provisioned Memory" },
      ],
    });
  });

  it("folds the tail into other and reports no data as null", () => {
    const jsonl = ["a", "b", "c", "d", "e", "f", "g"]
      .map((name, index) => focus("2026-08-27", name, 10 - index))
      .join("\n");
    const summary = summarizeVercelCharges(jsonl, WINDOW);
    assert.equal(summary.lines.length, 6);
    assert.deepEqual(summary.lines.at(-1), { cost: 9, name: "other" });
    assert.equal(summary.averageCost, null);
    assert.equal(summarizeVercelCharges("", WINDOW).cost, null);
    assert.equal(summarizeVercelCharges(null, WINDOW).cost, null);
  });

  it("accepts rows the transport already parsed", () => {
    const rows = [JSON.parse(focus("2026-08-27", "Functions", 3))];
    assert.equal(summarizeVercelCharges(rows, WINDOW).cost, 3);
  });
});

describe("gateway spend", () => {
  it("averages the comparison days and lists models largest first", () => {
    const summary = summarizeGatewaySpend(
      [
        { day: "2026-08-27", totalCost: 30 },
        { day: "2026-08-26", totalCost: 20 },
        { day: "2026-08-25", totalCost: 10 },
      ],
      [
        { model: "google/gemini-3.5-flash", totalCost: 5 },
        { model: "deepseek/deepseek-v4-pro-0813", totalCost: 25 },
      ],
      WINDOW
    );
    assert.deepEqual(summary, {
      averageCost: 15,
      cost: 30,
      lines: [
        { cost: 25, name: "deepseek/deepseek-v4-pro-0813" },
        { cost: 5, name: "google/gemini-3.5-flash" },
      ],
    });
  });
});

describe("rendered report", () => {
  it("totals both sources, shows deltas, and estimates credit runway", () => {
    const text = renderCostReport({
      credits: { balance: 50, totalUsed: 500 },
      gateway: {
        averageCost: 20,
        cost: 30,
        lines: [{ cost: 30, name: "deepseek/deepseek-v4-pro-0813" }],
      },
      reportDay: "2026-08-27",
      vercel: {
        averageCost: 10,
        cost: 5,
        lines: [
          { cost: 4, name: "Snapshot Storage" },
          { cost: 1, name: "other" },
        ],
      },
    });
    assert.equal(
      text,
      [
        "*Foreman running costs for 2026-08-27* (USD)",
        "Total: $35.00 (7-day avg $30.00, +17%)",
        "AI Gateway: $30.00 (7-day avg $20.00, +50%); deepseek/deepseek-v4-pro-0813 $30.00",
        "Vercel platform: $5.00 (7-day avg $10.00, -50%); Snapshot Storage $4.00 · other $1.00",
        "AI Gateway credits left: $50.00, about 2 days at the 7-day average",
        NOT_TRACKED,
      ].join("\n")
    );
  });

  it("withholds the total comparison when one source has no history", () => {
    const text = renderCostReport({
      credits: { balance: 50, totalUsed: 500 },
      gateway: { averageCost: 20, cost: 30, lines: [] },
      reportDay: "2026-08-27",
      vercel: { averageCost: null, cost: 5, lines: [] },
    });
    assert.match(text, TOTAL_WITHOUT_COMPARISON);
    assert.match(text, GATEWAY_WITH_COMPARISON);
  });

  it("keeps posting when one source failed", () => {
    const text = renderCostReport({
      credits: { error: "AI Gateway credits read could not run." },
      gateway: { averageCost: null, cost: 30, lines: [] },
      reportDay: "2026-08-27",
      vercel: { error: "Vercel billing responded HTTP 404." },
    });
    assert.equal(
      text,
      [
        "*Foreman running costs for 2026-08-27* (USD)",
        "Total: $30.00 (no comparison yet), one source missing",
        "AI Gateway: $30.00 (no comparison yet)",
        "Vercel platform: unavailable (Vercel billing responded HTTP 404.)",
        "AI Gateway credits: unavailable (AI Gateway credits read could not run.)",
        "Not tracked: Neon (Foreman memory and support Postgres), CLI Proxy on Railway (Claude models), GitHub Actions CI",
      ].join("\n")
    );
  });
});
