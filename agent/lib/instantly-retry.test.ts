const EXPECTED_ERROR_1 = /caller cancelled/u;
const EXPECTED_ERROR_2 = /within 15 seconds/u;

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { ProviderClient, ProviderResult } from "./executor/operations.js";
import {
  InstantlyApiError,
  listInstantlySubworkspaces,
} from "./instantly-api.js";
import { json, member } from "./instantly-fixtures.js";

describe("Instantly typed transport and retries", () => {
  it("honors short retry hints and returns the long retry interval without retrying", async () => {
    for (const [hint, expectedCalls, expectedDelays] of [
      ["1", 2, [1000]],
      ["60", 1, []],
    ] as const) {
      let calls = 0;
      const delays: number[] = [];
      const pending = listInstantlySubworkspaces({
        client: () => {
          calls += 1;
          return calls === 1
            ? json({ private: "provider body" }, 429, { "Retry-After": hint })
            : json({ items: [member()] });
        },
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      });
      if (hint === "60") {
        // biome-ignore lint/performance/noAwaitInLoops: sequential cases isolate client counters and timers.
        await assert.rejects(
          pending,
          (error) =>
            error instanceof InstantlyApiError &&
            error.retryAfterSeconds === 60 &&
            !error.message.includes("provider body")
        );
      } else {
        assert.equal((await pending).totalMatches, 1);
      }
      assert.equal(calls, expectedCalls);
      assert.deepEqual(delays, expectedDelays);
    }
  });
  it("supports HTTP-date retry hints", async () => {
    const date = new Date(Date.now() + 60_000).toUTCString();

    await assert.rejects(
      listInstantlySubworkspaces({
        client: () => json(null, 429, { "Retry-After": date }),
      }),
      (error) =>
        error instanceof InstantlyApiError &&
        (error.retryAfterSeconds ?? 0) >= 59
    );
  });
  it("retries transient responses and network failures with bounded backoff", async () => {
    for (const failure of [
      () => json(null, 503),
      () => Promise.reject(new Error("network")),
    ]) {
      let calls = 0;
      const delays: number[] = [];
      // biome-ignore lint/performance/noAwaitInLoops: sequential cases isolate client counters and timers.
      await listInstantlySubworkspaces({
        client: () => {
          calls += 1;
          return calls < 3 ? failure() : json({ items: [member()] });
        },
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      });
      assert.equal(calls, 3);
      assert.deepEqual(delays, [500, 1000]);
    }
  });
  it("distinguishes authorization, not-found, and rate limits without exposing provider bodies", async () => {
    for (const [status, kind] of [
      [401, "authorization"],
      [403, "authorization"],
      [404, "not-found"],
      [429, "rate-limited"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential cases isolate client counters and timers.
      await assert.rejects(
        listInstantlySubworkspaces({
          client: () => json({ detail: "private" }, status),
          sleep: () => Promise.resolve(),
        }),
        (error) =>
          error instanceof InstantlyApiError &&
          error.kind === kind &&
          error.status === status &&
          !error.message.includes("private")
      );
    }
  });
  it("preserves caller cancellation and never retries its own deadline", async () => {
    for (const cancel of [true, false]) {
      mock.timers.enable({ apis: ["setTimeout"] });
      const controller = new AbortController();
      let calls = 0;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const client: ProviderClient = (_request, options) =>
        new Promise<ProviderResult>((_resolve, reject) => {
          calls += 1;
          started();
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true }
          );
        });
      try {
        const pending = listInstantlySubworkspaces({
          client,
          signal: controller.signal,
        });
        // biome-ignore lint/performance/noAwaitInLoops: sequential cases isolate client counters and timers.
        await ready;
        if (cancel) {
          controller.abort(new Error("caller cancelled"));
        } else {
          mock.timers.tick(15_000);
        }

        await assert.rejects(
          pending,
          cancel ? EXPECTED_ERROR_1 : EXPECTED_ERROR_2
        );
        assert.equal(calls, 1);
      } finally {
        mock.timers.reset();
      }
    }
  });
});
