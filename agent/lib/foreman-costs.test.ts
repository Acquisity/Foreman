import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderClient } from "./executor/operations.js";
import { ExecutorError } from "./executor/transport.js";
import {
  COMPARISON_DAYS,
  costWindow,
  FOREMAN_PROJECT_ID,
  failureReason,
  NOT_TRACKED,
  readVercelCharges,
  renderCostBlocks,
  renderCostReport,
  summarizeGatewaySpend,
  summarizeVercelCharges,
  VERCEL_TEAM_ID,
} from "./foreman-costs.js";

/** 13:00 UTC on 2026-08-28, the production tick. */
const NOW = Date.parse("2026-08-28T13:00:00.000Z");
const WINDOW = costWindow(NOW);
const UNREADABLE = /unreadable billing export/u;
const REFUSED = /HTTP 404/u;
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
      reportDay: "2026-08-27",
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
  it("reads separate exact Pacific report and comparison windows in summer and winter", async () => {
    await Promise.all(
      (
        [
          [
            "2026-08-28T13:00:00Z",
            "2026-08-27T07:00:00.000Z",
            "2026-08-28T07:00:00.000Z",
            "2026-08-20T07:00:00.000Z",
          ],
          [
            "2026-12-12T13:00:00Z",
            "2026-12-11T08:00:00.000Z",
            "2026-12-12T08:00:00.000Z",
            "2026-12-04T08:00:00.000Z",
          ],
          [
            "2026-11-02T13:00:00Z",
            "2026-11-01T07:00:00.000Z",
            "2026-11-02T08:00:00.000Z",
            "2026-10-25T07:00:00.000Z",
          ],
          [
            "2026-03-09T13:00:00Z",
            "2026-03-08T08:00:00.000Z",
            "2026-03-09T07:00:00.000Z",
            "2026-03-01T08:00:00.000Z",
          ],
        ] as const
      ).map(async ([now, reportFrom, reportTo, comparisonFrom]) => {
        const window = costWindow(Date.parse(now));
        const calls: unknown[] = [];
        const client: ProviderClient = (request, options) => {
          calls.push({ options, request });
          assert.ok("from" in request.input);
          const day =
            request.input.from === reportFrom
              ? window.reportDay
              : window.firstDay;
          const cost = request.input.from === reportFrom ? 14.56 : 70;
          return Promise.resolve({
            data: focus(day, "Storage", cost),
            status: 200,
          });
        };
        const { signal } = new AbortController();
        assert.deepEqual(await readVercelCharges(client, window, signal), {
          averageCost: 10,
          cost: 14.56,
          lines: [{ cost: 14.56, name: "Storage" }],
        });
        assert.deepEqual(
          calls,
          [reportFrom, comparisonFrom].map((from, index) => ({
            options: { signal, wireMaxBytes: 32 * 1024 * 1024 },
            request: {
              input: {
                from,
                teamId: VERCEL_TEAM_ID,
                to: index === 0 ? reportTo : reportFrom,
              },
              operation: "vercel.billingCharges",
            },
          }))
        );
      })
    );
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
      averageCost: 8 / 7,
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
    assert.equal(summary.averageCost, 0);
    assert.equal(summarizeVercelCharges("", WINDOW).cost, null);
    assert.throws(() => summarizeVercelCharges(null, WINDOW), UNREADABLE);
  });

  it("accepts rows the transport already parsed", () => {
    const rows = [JSON.parse(focus("2026-08-27", "Functions", 3))];
    assert.equal(summarizeVercelCharges(rows, WINDOW).cost, 3);
  });
});

describe("source completeness", () => {
  it("averages sparse successful gateway and Vercel histories over seven calendar days", () => {
    assert.equal(
      summarizeGatewaySpend(
        [{ day: WINDOW.firstDay, totalCost: 70 }],
        [],
        WINDOW
      ).averageCost,
      10
    );
    assert.equal(
      summarizeVercelCharges(focus(WINDOW.firstDay, "Storage", 70), WINDOW)
        .averageCost,
      10
    );
    assert.equal(summarizeGatewaySpend([], [], WINDOW).averageCost, 0);
    assert.equal(summarizeVercelCharges([], WINDOW).averageCost, 0);
  });

  it("renders missing report-day rows unavailable and totals only numeric sources", () => {
    const missing = { averageCost: 0, cost: null, lines: [] };
    const base = {
      credits: { error: "unavailable" },
      gateway: missing,
      reportDay: WINDOW.reportDay,
      vercel: missing,
    };
    const absent = renderCostReport(base);
    assert.ok(absent.includes("Total: unavailable"));
    assert.ok(!absent.includes("$0.00"));
    assert.ok(
      absent.includes(
        `AI Gateway: unavailable (no rows for ${WINDOW.reportDay} yet)`
      )
    );
    assert.ok(
      absent.includes(
        `Vercel platform: unavailable (no rows for ${WINDOW.reportDay} yet)`
      )
    );
    for (const source of ["gateway", "vercel"]) {
      const partial = renderCostReport({
        ...base,
        [source]: { averageCost: 10, cost: 20, lines: [] },
      });
      assert.ok(partial.includes("Total (partial): $20.00"));
    }
  });

  it("rejects wholly unreadable nonempty billing exports and unsupported shapes", () => {
    for (const body of [
      "<html>bad body</html>",
      "{}\n{broken",
      [{ unrelated: true }],
      { data: [] },
    ]) {
      assert.throws(() => summarizeVercelCharges(body, WINDOW), UNREADABLE);
    }
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
      averageCost: 30 / 7,
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
      credits: { balance: 50 },
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
      credits: { balance: 50 },
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
        "Total (partial): $30.00 (no comparison yet)",
        "AI Gateway: $30.00 (no comparison yet)",
        "Vercel platform: unavailable (Vercel billing responded HTTP 404.)",
        "AI Gateway credits: unavailable (AI Gateway credits read could not run.)",
        "Not tracked: Neon (Foreman memory and support Postgres), CLI Proxy on Railway (Claude models), GitHub Actions CI",
      ].join("\n")
    );
  });
});

describe("cost tool error boundary", () => {
  it("keeps gateway secret messages and nested response bodies out of tool output and logs", async (t) => {
    const previousKey = process.env.AI_GATEWAY_API_KEY;
    const previousConnector = process.env.EXECUTOR_MCP_CONNECTOR;
    process.env.AI_GATEWAY_API_KEY = "fixture-key";
    process.env.EXECUTOR_MCP_CONNECTOR ??= "executor/test";
    const marker = "SECRET_GATEWAY_DIAGNOSTIC_MARKER";
    const logs: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            error: { message: marker, type: "internal_server_error" },
            privateRows: [marker],
          }),
          { headers: { "content-type": "application/json" }, status: 500 }
        )
    );
    try {
      const { default: tool } = await import("../tools/read_foreman_costs.js");
      const context = {
        abortSignal: new AbortController().signal,
        getToken: () => {
          throw new Error("fixture Executor unavailable");
        },
        session: {
          auth: { current: { attributes: {}, authenticator: "local-dev" } },
        },
      } as unknown as Parameters<typeof tool.execute>[1];
      const output = await tool.execute({}, context);
      assert.ok("available" in output);
      assert.equal(output.available, true);
      assert.ok(output.report?.includes("AI Gateway: unavailable (HTTP 500)"));
      assert.ok(!JSON.stringify(output).includes(marker));
      assert.ok(!JSON.stringify(logs).includes(marker));
      assert.ok(
        logs.every((args) => args.length === 1 && typeof args[0] === "string")
      );
    } finally {
      if (previousKey === undefined) {
        delete process.env.AI_GATEWAY_API_KEY;
      } else {
        process.env.AI_GATEWAY_API_KEY = previousKey;
      }
      if (previousConnector === undefined) {
        delete process.env.EXECUTOR_MCP_CONNECTOR;
      } else {
        process.env.EXECUTOR_MCP_CONNECTOR = previousConnector;
      }
    }
  });
});

describe("cost message", () => {
  const report = {
    credits: { balance: 550.42 },
    gateway: {
      averageCost: 146.09,
      cost: 7.28,
      lines: [
        { cost: 4.18, name: "openai/gpt-5.6-sol" },
        { cost: 1.24, name: "deepseek/deepseek-v4.1-flash" },
        { cost: 0.88, name: "google/gemini-3.5-flash-lite" },
        { cost: 0.5, name: "x/fourth" },
      ],
    },
    reportDay: "2026-10-11",
    vercel: { error: "operation_not_bound" },
  };

  it("renders Block Kit with a header, partial total, and unavailable source", () => {
    const { blocks, text } = renderCostBlocks(report);
    assert.equal(
      text,
      "Foreman running costs for 2026-10-11: $7.28 (▼ 95% vs 7-day avg $146.09)"
    );
    const json = JSON.stringify(blocks);
    const [header, total] = blocks as { text: { text: string } }[];
    assert.equal(header.text.text, "Foreman running costs · Sunday, Oct 11");
    assert.match(total.text.text, /^\*\$7\.28\* .*partial/u);
    assert.ok(json.includes("•  openai/gpt-5.6-sol   $4.18"));
    assert.ok(!json.includes("x/fourth"));
    assert.ok(
      json.includes("*Vercel platform*   unavailable\\n_operation_not_bound_")
    );
    assert.ok(json.includes("Not tracked: Neon"));
  });

  it("reports an Executor code as the failure reason", () => {
    assert.equal(
      failureReason(new ExecutorError("operation_not_bound"), "fallback"),
      "operation_not_bound"
    );
    assert.equal(
      failureReason(
        new Error("x", { cause: new ExecutorError("executor_not_configured") }),
        "fallback"
      ),
      "executor_not_configured"
    );
  });
});
