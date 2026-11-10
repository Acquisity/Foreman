import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deliverAiSdrReport } from "./ai-sdr-report-delivery.js";
import type { AiSdrWeeklyReportResult } from "./ai-sdr-weekly-report.js";

describe("deliverAiSdrReport", () => {
  test("posts only the fixed line from code on a failed read and never starts a model turn", async () => {
    const posts: string[] = [];
    const dispatches: string[] = [];
    await deliverAiSdrReport({
      dispatch: (prompt) => {
        dispatches.push(prompt);
        return Promise.resolve();
      },
      post: (text) => {
        posts.push(text);
        return Promise.resolve();
      },
      read: () =>
        Promise.resolve({ error: "a production read failed", success: false }),
    });
    assert.deepEqual(posts, [
      "The weekly AI SDR report could not be generated: a production read failed",
    ]);
    assert.deepEqual(dispatches, []);
  });

  test("hands a complete report to the model and posts nothing itself", async () => {
    const posts: string[] = [];
    const dispatches: string[] = [];
    const report = {
      success: true,
      windows: { report: { start: "2026-11-02" } },
    } as unknown as AiSdrWeeklyReportResult;
    await deliverAiSdrReport({
      dispatch: (prompt) => {
        dispatches.push(prompt);
        return Promise.resolve();
      },
      post: (text) => {
        posts.push(text);
        return Promise.resolve();
      },
      read: () => Promise.resolve(report),
    });
    assert.deepEqual(posts, []);
    assert.equal(dispatches.length, 1);
    assert.ok(dispatches[0]?.includes("Do not call any tool."));
    assert.ok(dispatches[0]?.endsWith(JSON.stringify(report)));
  });
});
