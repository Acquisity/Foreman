import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

test("scorecard defaults to eval results without requiring a previous judge directory", () => {
  const cwd = mkdtempSync(`${tmpdir()}/widget-scorecard-cli-`);
  try {
    const replay = `${cwd}/.eve/evals/2026-10-09/evals/widget/replay`;
    mkdirSync(replay, { recursive: true });
    writeFileSync(
      `${replay}/0.json`,
      JSON.stringify({
        result: {
          logs: [
            `row: ${JSON.stringify({ answer: null, case: resolve("evals/widget/cases/inv-video-lessons-missing.json"), leaks: "pass", rawFields: "pass", scored: true })}`,
          ],
        },
      })
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        resolve("node_modules/tsx/dist/loader.mjs"),
        resolve("scripts/widget-judge.ts"),
        "scorecard",
      ],
      { cwd, encoding: "utf8", timeout: 30_000 }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.stdout.includes("1 replays, 1 scored, 0 missing judge coverage")
    );
    assert.ok(result.stdout.includes("| found the real cause | 0.0% | 1 |"));
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});
