import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const RUNNER = join(REPO, "scripts/triage-replay.ts");
const CHANGED_COHORT = /changed since cohort\.json was frozen/u;

const runIn = (dir: string) =>
  spawnSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      RUNNER,
      "--url",
      "http://127.0.0.1:9",
      "--run-id",
      "test",
      "--archives",
      join(dir, "archives.json"),
      "--cases",
      "ENG-0",
    ],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, FOREMAN_DIAGNOSTICS_SECRET: "test" },
    }
  );

describe("triage replay runner", () => {
  it("refuses to start when a frozen list changed since the cohort was frozen", () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-runner-"));
    try {
      cpSync(join(REPO, "evals/triage"), join(dir, "evals/triage"), {
        recursive: true,
      });
      writeFileSync(join(dir, "archives.json"), "{}");
      writeFileSync(join(dir, "evals/triage/frozen/states.json"), "[]\n");
      const result = runIn(dir);
      assert.equal(result.status, 2);
      assert.match(result.stderr, CHANGED_COHORT);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
