import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Guards the P8 audit recorded in `.github/OUTSIDE-CALLS.md`: every authored
 * call that leaves the process has a deadline. These are source checks because
 * the risk is a new call site added without one, not the behaviour of any call
 * already written.
 */

const AGENT_ROOT = new URL("../", import.meta.url);
const TOOL_ROOTS = ["tools/", "subagents/"];
const RAW_RUN = /\bsandbox\.run\(/u;
const GIT_COMMAND = /git -C /u;
const BLOB_CALL = /\b(?:del|get|head|put)\(\s*key\b/gu;
const ABORT_SIGNAL = /abortSignal:/u;

/** Every authored non-test TypeScript file under the given directory. */
const sourceFiles = (dir: URL): URL[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return sourceFiles(new URL(`${entry.name}/`, dir));
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [new URL(entry.name, dir)]
      : [];
  });

describe("authored outside calls stay bounded", () => {
  it("runs every sandbox git command through boundedRun", () => {
    const unbounded = TOOL_ROOTS.flatMap((root) =>
      sourceFiles(new URL(root, AGENT_ROOT))
    )
      .map((file) => ({ file, source: readFileSync(file, "utf8") }))
      .filter(({ source }) => GIT_COMMAND.test(source) && RAW_RUN.test(source))
      .map(({ file }) => file.pathname);
    assert.deepEqual(
      unbounded,
      [],
      `These tools run git in the sandbox without a deadline: ${unbounded.join(", ")}`
    );
  });

  it("gives every Blob operation an abort signal", () => {
    const source = readFileSync(new URL("blob.ts", import.meta.url), "utf8");
    const calls = [...source.matchAll(BLOB_CALL)];
    assert.ok(calls.length >= 4, "expected the four Blob document operations");
    for (const call of calls) {
      const tail = source.slice(call.index, call.index + 400);
      assert.match(
        tail,
        ABORT_SIGNAL,
        `Blob call at index ${call.index} carries no abortSignal.`
      );
    }
  });
});
