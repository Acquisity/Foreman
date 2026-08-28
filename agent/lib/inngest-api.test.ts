import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { errorText, findFunctionRuns } from "./inngest-api.js";

const NOW = new Date("2026-08-27T18:00:00.000Z");
const FN = "ads.google.sync-workspace-insights";
const MORE_THAN = /more than/u;
const HTTP_500 = /HTTP 500/u;
const ABORTED = /aborted/u;

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

  it("traces the newest run across apps, not the first app's newest", async () => {
    const urls: string[] = [];
    const fetchStub: typeof fetch = (url) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/apps?")) {
        return json({
          data: [{ id: "app-a" }, { id: "app-b" }],
          page: { hasMore: false },
        });
      }
      if (u.includes("/apps/app-a/functions/")) {
        return json({
          data: [
            { ...run("old", "evt-old"), queuedAt: "2026-08-27T10:00:00Z" },
          ],
          page: { hasMore: false },
        });
      }
      if (u.includes("/apps/app-b/functions/")) {
        return json({
          data: [
            { ...run("new", "evt-new"), queuedAt: "2026-08-27T12:00:00Z" },
          ],
          page: { hasMore: false },
        });
      }
      return json(trace);
    };
    const result = await findFunctionRuns(
      "t",
      { functionId: FN, sinceHours: 24, status: "Failed" },
      { fetch: fetchStub, now: NOW }
    );
    assert.deepEqual(
      result.runs.map((r) => r.runId),
      ["new", "old"]
    );
    assert.equal(result.latestTrace?.runId, "new");
    assert.ok(urls.at(-1)?.includes("/runs/new/trace"));
  });

  it("treats a 200 answer with no data list for an unknown function as no runs", async () => {
    const fetchStub: typeof fetch = (url) => {
      const u = String(url);
      if (u.includes("/apps?")) {
        return json({ data: [{ id: "ai-clients" }], page: { hasMore: false } });
      }
      return json({ error: "function not found" });
    };
    const result = await findFunctionRuns(
      "t",
      { functionId: "no.such.function", sinceHours: 24, status: "Failed" },
      { fetch: fetchStub, now: NOW }
    );
    assert.deepEqual(result, { latestTrace: null, runs: [], truncated: false });
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
      errorText("empty eyJhbGciOiJIUzI1NiJ9.e30.abc end"),
      "empty [redacted] end"
    );
    assert.equal(
      errorText('{"dsn":"postgres://u:p@host/db","step":2}'),
      '{"dsn":"[redacted]","step":2}'
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

  it("fails closed when the app list exceeds the page cap", async () => {
    const result = await findFunctionRuns(
      "t",
      { functionId: FN, sinceHours: 1, status: "Failed" },
      {
        fetch: () =>
          json({
            data: [{ id: "a" }],
            page: { cursor: "next", hasMore: true },
          }),
        now: NOW,
      }
    );
    assert.match(result.error ?? "", MORE_THAN);
    assert.deepEqual(result.runs, []);
  });

  it("retries the trace without output, then keeps the runs with traceError", async () => {
    const urls: string[] = [];
    const withRetry: typeof fetch = (url) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/trace?includeOutput=true")) {
        return json({ message: "boom" }, 500);
      }
      if (u.endsWith("/trace")) {
        return json(trace);
      }
      return json({ data: [run("run-2", "evt-2")] });
    };
    const recovered = await findFunctionRuns(
      "t",
      { sinceHours: 1, status: "Failed" },
      { fetch: withRetry, now: NOW }
    );
    assert.equal(recovered.latestTrace?.steps.length, 3);
    assert.equal(recovered.traceError, undefined);
    assert.ok(urls.some((u) => u.endsWith("/runs/run-2/trace")));

    const bothFail: typeof fetch = (url) =>
      String(url).includes("/trace")
        ? json({ message: "boom" }, 500)
        : json({ data: [run("run-2", "evt-2")] });
    const kept = await findFunctionRuns(
      "t",
      { sinceHours: 1, status: "Failed" },
      { fetch: bothFail, now: NOW }
    );
    assert.equal(kept.runs.length, 1);
    assert.equal(kept.latestTrace, null);
    assert.equal(kept.error, undefined);
    assert.match(kept.traceError ?? "", HTTP_500);

    const malformed = await findFunctionRuns(
      "t",
      { sinceHours: 1, status: "Failed" },
      {
        fetch: (url) =>
          String(url).includes("/trace")
            ? json({ data: "invalid" })
            : json({ data: [run("run-2", "evt-2")] }),
        now: NOW,
      }
    );
    assert.equal(malformed.runs.length, 1);
    assert.equal(malformed.error, undefined);
    assert.ok(malformed.traceError);
  });

  it("rethrows caller cancellation instead of retrying or reporting it", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchStub: typeof fetch = (url) => {
      calls += 1;
      if (String(url).includes("/trace")) {
        controller.abort();
        return Promise.reject(new Error("aborted"));
      }
      return json({ data: [run("run-2", "evt-2")] });
    };
    await assert.rejects(
      findFunctionRuns(
        "t",
        { sinceHours: 1, status: "Failed" },
        { fetch: fetchStub, now: NOW, signal: controller.signal }
      ),
      ABORTED
    );
    assert.equal(calls, 2);
  });
});
