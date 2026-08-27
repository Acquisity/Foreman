import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { errorText, findFunctionRuns } from "./inngest-api.js";

const NOW = new Date("2026-08-27T18:00:00.000Z");
const FN = "ads.google.sync-workspace-insights";
const MORE_THAN = /more than/u;

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status,
    })
  );

const run = (id: string, eventId: string) => ({
  app: { id: "ai-clients" },
  endedAt: "2026-08-27T17:00:05Z",
  function: { id: FN, name: "Google Ads" },
  id,
  queuedAt: "2026-08-27T16:59:00Z",
  startedAt: "2026-08-27T17:00:00Z",
  status: "FAILED",
  trigger: { eventIds: [eventId] },
});

const trace = {
  data: {
    rootSpan: {
      children: [
        {
          endedAt: "2026-08-27T17:00:01Z",
          name: "load-org",
          startedAt: "2026-08-27T17:00:00Z",
          status: "COMPLETED",
        },
        {
          children: [
            {
              name: "Attempt 0",
              startedAt: "2026-08-27T17:00:01Z",
              status: "FAILED",
            },
          ],
          endedAt: "2026-08-27T17:00:05Z",
          error: { message: "boom for ada@example.com token=abcdefghijkl" },
          name: "call-provider",
          startedAt: "2026-08-27T17:00:01Z",
          status: "FAILED",
        },
      ],
      name: "Run",
      status: "FAILED",
    },
    runId: "run-2",
  },
};

describe("find_function_runs", () => {
  it("lists a function's runs through its app with the status filter and window, then traces the newest", async () => {
    const urls: string[] = [];
    const fetchStub: typeof fetch = (url) => {
      const u = String(url);
      urls.push(u);
      if (u.endsWith("/apps?limit=20")) {
        return json({
          data: [{ id: "other-app" }],
          page: { cursor: "c1", hasMore: true },
        });
      }
      if (u.endsWith("/apps?limit=20&cursor=c1")) {
        return json({ data: [{ id: "ai-clients" }], page: { hasMore: false } });
      }
      if (u.includes("/apps/other-app/")) {
        return json({ message: "not found" }, 404);
      }
      if (u.includes("/apps/ai-clients/functions/")) {
        return json({
          data: [run("run-2", "evt-2"), run("run-1", "evt-1")],
          page: { hasMore: true },
        });
      }
      return json(trace);
    };
    const result = await findFunctionRuns(
      "t",
      { functionId: FN, sinceHours: 24, status: "Failed" },
      { fetch: fetchStub, now: NOW }
    );
    const list = new URL(urls[3] ?? "");
    assert.equal(list.pathname, `/v2/apps/ai-clients/functions/${FN}/runs`);
    assert.equal(list.searchParams.get("status"), "FAILED");
    assert.equal(list.searchParams.get("from"), "2026-08-26T18:00:00.000Z");
    assert.equal(
      urls[4],
      "https://api.inngest.com/v2/runs/run-2/trace?includeOutput=true"
    );
    assert.equal(result.truncated, true);
    assert.deepEqual(
      result.runs.map((r) => [r.runId, r.functionId, r.eventId]),
      [
        ["run-2", FN, "evt-2"],
        ["run-1", FN, "evt-1"],
      ]
    );
    assert.equal(result.latestTrace?.runId, "run-2");
    assert.deepEqual(
      result.latestTrace?.steps.map((s) => [s.name, s.status]),
      [
        ["load-org", "COMPLETED"],
        ["call-provider", "FAILED"],
        ["Attempt 0", "FAILED"],
      ]
    );
    assert.equal(
      result.latestTrace?.steps[1]?.error,
      "boom for [redacted] [redacted]"
    );
  });

  it("lists across every function without an id, and returns latestTrace null without a second request when nothing ran", async () => {
    const urls: string[] = [];
    const result = await findFunctionRuns(
      "t",
      { sinceHours: 24, status: "Cancelled" },
      {
        fetch: (url) => {
          urls.push(String(url));
          return json({ data: [] });
        },
        now: NOW,
      }
    );
    assert.equal(urls.length, 1);
    assert.ok(urls[0]?.startsWith("https://api.inngest.com/v2/runs?"));
    assert.ok(urls[0]?.includes("status=CANCELLED"));
    assert.deepEqual(result, { latestTrace: null, runs: [], truncated: false });
  });

  it("reports trace truncation only when steps were dropped", async () => {
    const spans = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        name: `s${i}`,
        status: "COMPLETED",
      }));
    const stub =
      (n: number): typeof fetch =>
      (url) =>
        String(url).includes("/trace")
          ? json({ data: { rootSpan: { children: spans(n), name: "Run" } } })
          : json({ data: [run("run-2", "evt-2")] });
    const exact = await findFunctionRuns(
      "t",
      { sinceHours: 1, status: "Failed" },
      { fetch: stub(200), now: NOW }
    );
    assert.equal(exact.latestTrace?.steps.length, 200);
    assert.equal(exact.latestTrace?.truncated, false);
    const over = await findFunctionRuns(
      "t",
      { sinceHours: 1, status: "Failed" },
      { fetch: stub(201), now: NOW }
    );
    assert.equal(over.latestTrace?.steps.length, 200);
    assert.equal(over.latestTrace?.truncated, true);
  });

  it("bounds and redacts error text and reports a failed read", async () => {
    assert.equal(errorText("x".repeat(600))?.length, 500);
    assert.equal(
      errorText("dsn postgres://user:password@db.example.com:5432/app failed"),
      "dsn [redacted] failed"
    );
    assert.equal(
      errorText(
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c end"
      ),
      "jwt [redacted] end"
    );
    assert.equal(
      errorText({ message: "org 4939211d-158a-48ae-8f9a-4b94a48ca221 failed" }),
      "org [id] failed"
    );
    const result = await findFunctionRuns(
      "t",
      { sinceHours: 1, status: "Failed" },
      { fetch: () => json({ message: "nope" }, 401), now: NOW }
    );
    assert.equal(result.error, "Inngest API /runs failed: HTTP 401.");
    assert.equal(result.latestTrace, null);
  });

  it("refuses a response larger than the byte cap", async () => {
    const result = await findFunctionRuns(
      "t",
      { sinceHours: 1, status: "Failed" },
      {
        fetch: () =>
          Promise.resolve(
            new Response("x".repeat(10), {
              headers: { "content-length": String(3 * 1024 * 1024) },
              status: 200,
            })
          ),
        now: NOW,
      }
    );
    assert.match(result.error ?? "", MORE_THAN);
  });
});
