import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeEval } from "./eval-summary.js";

const report = (failed = false) => ({
  failed: failed ? 1 : 0,
  passed: failed ? 0 : 1,
  results: [
    {
      assertions: [
        {
          message: "Expected tool was not called",
          name: "calledTool",
          passed: !failed,
        },
      ],
      id: "smoke",
      verdict: failed ? "failed" : "passed",
    },
  ],
  scored: 0,
  skipped: 0,
});

describe("eval summary", () => {
  it("projects JSON verdicts and counts without arbitrary output or metadata", () => {
    const output = `booting\nAI_GATEWAY_API_KEY=placeholder\n${JSON.stringify(
      { ...report(), environment: "PRIVATE_VALUE=hidden", traces: ["hidden"] },
      null,
      2
    )}\nPRIVATE_VALUE=hidden\n`;
    assert.deepEqual(summarizeEval(0, output), {
      exitCode: 0,
      firstError: null,
      success: true,
      summary:
        "smoke: passed\nResults: 1 passed, 0 failed, 0 scored, 0 skipped (1 total)",
    });
  });

  it("retains the first failed gate without requiring the word error", () => {
    const data = report(true);
    data.results.push(
      ...Array.from({ length: 200 }, (_, index) => ({
        assertions: [],
        id: `later/${index}`,
        verdict: "passed",
      }))
    );
    data.passed = 200;
    const result = summarizeEval(1, JSON.stringify(data, null, 2));
    assert.equal(result.firstError, "Expected tool was not called");
    assert.ok(result.summary.startsWith("smoke: failed\n"));
    assert.ok(result.summary.endsWith("(201 total)"));
    assert.ok(result.summary.length <= 4000);
    assert.equal(result.success, false);
  });

  it("returns a bounded execution error when no assertion failed", () => {
    const data = report(true);
    data.results[0].assertions = [];
    const result = summarizeEval(
      1,
      JSON.stringify({
        ...data,
        results: [
          { ...data.results[0], error: "transport failed ".repeat(100) },
        ],
      })
    );
    assert.ok(result.firstError?.startsWith("transport failed"));
    assert.ok((result.firstError?.length ?? 0) <= 500);
  });

  it("excludes environment lines from failure diagnostics", () => {
    const data = report(true);
    data.results[0].assertions[0].message =
      "PRIVATE_VALUE=hidden\nexport AI_GATEWAY_API_KEY=placeholder\nExpected tool was not called";
    assert.equal(
      summarizeEval(1, JSON.stringify(data)).firstError,
      "Expected tool was not called"
    );
  });

  for (const exitCode of [124, 137]) {
    it(`reports timeout exit ${exitCode} without returning raw output`, () => {
      assert.deepEqual(summarizeEval(exitCode, "PRIVATE_VALUE=hidden"), {
        exitCode,
        firstError: "Eval command exceeded its shell timeout.",
        success: false,
        summary: "Eval command exceeded its shell timeout.",
      });
    });
  }

  it("fails closed without a valid report and excludes boot output", () => {
    for (const output of ["PRIVATE_VALUE=hidden", '{"results":[]}', ""]) {
      const result = summarizeEval(2, output);
      assert.equal(result.success, false);
      assert.equal(
        result.firstError,
        "Eval command exited 2 without a valid JSON report."
      );
      assert.equal(result.summary, result.firstError);
    }
    assert.equal(summarizeEval(0, "").success, false);
  });
});
