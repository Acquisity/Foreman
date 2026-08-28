import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMPARISON_DAYS,
  costWindow,
  FOREMAN_PROJECT_ID,
  readVercelCharges,
  renderCostReport,
  summarizeGatewaySpend,
  summarizeVercelCharges,
  VERCEL_TEAM_ID,
} from "./foreman-costs.js";

/** 13:00 UTC on 2026-08-28, the production tick. */
const NOW = Date.parse("2026-08-28T13:00:00.000Z");
const WINDOW = costWindow(NOW);
const REFUSED = /Vercel billing responded 403/u;

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
});

describe("Vercel charges", () => {
  it("calls the FOCUS export for the team over the window", async () => {
    let calledUrl = "";
    let calledInit: RequestInit | undefined;
    const fetchStub: typeof fetch = (input, init) => {
      calledUrl = String(input);
      calledInit = init;
      return Promise.resolve(new Response("{}\n", { status: 200 }));
    };
    const text = await readVercelCharges("tok", WINDOW, { fetch: fetchStub });
    assert.equal(text, "{}\n");
    const called = new URL(calledUrl);
    assert.equal(
      called.origin + called.pathname,
      "https://api.vercel.com/v1/billing/charges"
    );
    assert.equal(called.searchParams.get("teamId"), VERCEL_TEAM_ID);
    assert.equal(called.searchParams.get("from"), WINDOW.from);
    assert.equal(called.searchParams.get("to"), WINDOW.to);
    assert.equal(
      new Headers(calledInit?.headers).get("Authorization"),
      "Bearer tok"
    );
  });

  it("names the status when the export is refused", async () => {
    const fetchStub: typeof fetch = () =>
      Promise.resolve(new Response("", { status: 403 }));
    await assert.rejects(
      readVercelCharges("tok", WINDOW, { fetch: fetchStub }),
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
        "AI Gateway: $30.00 (7-day avg $20.00, +50%) — deepseek/deepseek-v4-pro-0813 $30.00",
        "Vercel platform: $5.00 (7-day avg $10.00, -50%) — Snapshot Storage $4.00 · other $1.00",
        "AI Gateway credits left: $50.00, about 2 days at the 7-day average",
      ].join("\n")
    );
  });

  it("keeps posting when one source failed", () => {
    const text = renderCostReport({
      credits: { error: "AI Gateway credits read could not run." },
      gateway: { averageCost: null, cost: 30, lines: [] },
      reportDay: "2026-08-27",
      vercel: { error: "VERCEL_API_CONNECTOR is not set." },
    });
    assert.equal(
      text,
      [
        "*Foreman running costs for 2026-08-27* (USD)",
        "Total: $30.00 (no comparison yet), one source missing",
        "AI Gateway: $30.00 (no comparison yet)",
        "Vercel platform: unavailable (VERCEL_API_CONNECTOR is not set.)",
        "AI Gateway credits: unavailable (AI Gateway credits read could not run.)",
      ].join("\n")
    );
  });
});
