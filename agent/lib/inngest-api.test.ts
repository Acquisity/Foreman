const EXPECTED_ERROR_1 = /HTTP 500/u;
const EXPECTED_ERROR_2 = /more than/u;
const EXPECTED_ERROR_3 = /aborted/u;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  OperationRequest,
  ProviderClient,
  ProviderResult,
} from "./executor/operations.js";
import { errorText, findFunctionRuns } from "./inngest-api.js";

const NOW = new Date("2026-08-27T18:00:00.000Z");
const FN = "ads.google.sync-workspace-insights";
const _MORE_THAN = /more than/u;
const _HTTP_500 = /HTTP 500/u;
const _ABORTED = /aborted/u;

const json = (data: unknown, status = 200): Promise<ProviderResult> =>
  Promise.resolve({ data, status });
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

describe("typed Inngest investigation", () => {
  it("follows app cursors, skips a non-owning app and traces the newest run", async () => {
    const requests: OperationRequest[] = [];
    const client: ProviderClient = (request) => {
      requests.push(request);
      if (request.operation === "inngest.apps") {
        return request.input.cursor
          ? json({ data: [{ id: "ai-clients" }] })
          : json({
              data: [{ id: "other" }],
              page: { cursor: "next", hasMore: true },
            });
      }
      if (request.operation === "inngest.functionRuns") {
        return request.input.appId === "other"
          ? json(null, 404)
          : json({
              data: [run("run-2", "evt-2"), run("run-1", "evt-1")],
              page: { hasMore: true },
            });
      }
      return json(trace);
    };
    const result = await findFunctionRuns(
      { functionId: FN, sinceHours: 24, status: "Failed" },
      { client, now: NOW }
    );
    assert.deepEqual(requests[3], {
      input: {
        appId: "ai-clients",
        from: "2026-08-26T18:00:00.000Z",
        functionId: FN,
        limit: 20,
        status: "FAILED",
      },
      operation: "inngest.functionRuns",
    });
    assert.deepEqual(requests[4], {
      input: { includeOutput: true, runId: "run-2" },
      operation: "inngest.trace",
    });
    assert.equal(result.runs.length, 2);
    assert.equal(result.truncated, true);
    assert.equal(result.latestTrace?.steps.length, 3);
    const output = JSON.stringify(result);
    assert.equal(output.includes("ada@example.com"), false);
    assert.equal(output.includes("abcdefghijkl"), false);
  });
  it("orders matching runs across apps before selecting the trace", async () => {
    const client: ProviderClient = (request) => {
      if (request.operation === "inngest.apps") {
        return json({ data: [{ id: "a" }, { id: "b" }] });
      }
      if (request.operation === "inngest.functionRuns") {
        return json({
          data: [
            {
              ...run(request.input.appId, "evt"),
              queuedAt:
                request.input.appId === "a"
                  ? "2026-08-25T00:00:00Z"
                  : "2026-08-26T00:00:00Z",
            },
          ],
        });
      }
      assert.equal(request.operation, "inngest.trace");
      assert.equal("runId" in request.input && request.input.runId, "b");
      return json(trace);
    };
    const result = await findFunctionRuns(
      { functionId: FN, sinceHours: 24, status: "Failed" },
      { client, now: NOW }
    );
    assert.deepEqual(
      result.runs.map((r) => r.runId),
      ["b", "a"]
    );
  });
  it("lists across functions without app discovery and treats empty as a valid result", async () => {
    const calls: OperationRequest[] = [];
    const result = await findFunctionRuns(
      { sinceHours: 24, status: "Cancelled" },
      {
        client: (request) => {
          calls.push(request);
          return json({ data: [] });
        },
        now: NOW,
      }
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.operation, "inngest.runs");
    assert.deepEqual(result, { latestTrace: null, runs: [], truncated: false });
  });
  it("retries a trace without output, preserving the runs if both reads fail", async () => {
    for (const failBoth of [false, true]) {
      const requests: OperationRequest[] = [];
      // biome-ignore lint/performance/noAwaitInLoops: each fixture is validated independently.
      const result = await findFunctionRuns(
        { sinceHours: 24, status: "Failed" },
        {
          client: (request) => {
            requests.push(request);
            if (request.operation === "inngest.runs") {
              return json({ data: [run("r", "e")] });
            }
            return request.operation === "inngest.trace" &&
              (request.input.includeOutput || failBoth)
              ? json(null, 500)
              : json(trace);
          },
          now: NOW,
        }
      );
      assert.equal(requests.length, 3);
      assert.deepEqual(requests[2], {
        input: { runId: "r" },
        operation: "inngest.trace",
      });
      assert.equal(result.runs.length, 1);
      if (failBoth) {
        assert.equal(result.latestTrace, null);
        assert.match(result.traceError ?? "", EXPECTED_ERROR_1);
      } else {
        assert.ok(result.latestTrace);
      }
    }
  });
  it("bounds app discovery and tolerates an app returning no run collection", async () => {
    let calls = 0;
    const result = await findFunctionRuns(
      { functionId: FN, sinceHours: 24, status: "Failed" },
      {
        client: () => {
          calls += 1;
          return json({
            data: [{ id: "a" }],
            page: { cursor: String(calls), hasMore: true },
          });
        },
        now: NOW,
      }
    );
    assert.equal(calls, 5);
    assert.match(result.error ?? "", EXPECTED_ERROR_2);
    const empty = await findFunctionRuns(
      { functionId: FN, sinceHours: 24, status: "Failed" },
      {
        client: (request) =>
          request.operation === "inngest.apps"
            ? json({ data: [{ id: "a" }] })
            : json({}),
        now: NOW,
      }
    );
    assert.deepEqual(empty.runs, []);
    assert.equal(empty.error, undefined);
  });
  it("distinguishes provider errors and oversized results from empty answers", async () => {
    for (const response of [
      json(null, 503),
      json({ data: [], padding: "x".repeat(2 * 1024 * 1024) }),
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each fixture is validated independently.
      const result = await findFunctionRuns(
        { sinceHours: 24, status: "Failed" },
        { client: () => response, now: NOW }
      );
      assert.ok(result.error);
      assert.deepEqual(result.runs, []);
    }
  });
  it("propagates caller cancellation without falling back or retrying", async () => {
    const controller = new AbortController();
    let calls = 0;

    await assert.rejects(
      findFunctionRuns(
        { sinceHours: 24, status: "Failed" },
        {
          client: () => {
            calls += 1;
            controller.abort();
            return Promise.reject(controller.signal.reason);
          },
          signal: controller.signal,
        }
      ),
      EXPECTED_ERROR_3
    );
    assert.equal(calls, 1);
  });
  it("bounds trace steps and redacts object/string error text", async () => {
    const result = await findFunctionRuns(
      { sinceHours: 24, status: "Failed" },
      {
        client: (request) =>
          request.operation === "inngest.runs"
            ? json({ data: [run("r", "e")] })
            : json({
                data: {
                  rootSpan: {
                    children: Array.from({ length: 205 }, (_, i) => ({
                      name: String(i),
                      status: "COMPLETED",
                    })),
                    name: "Run",
                  },
                },
              }),
      }
    );
    assert.equal(result.latestTrace?.steps.length, 200);
    assert.equal(result.latestTrace?.truncated, true);
    assert.equal(errorText(null), undefined);
    assert.equal(errorText({ message: "x".repeat(600) })?.length, 500);
  });
});
