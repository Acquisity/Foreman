import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { SandboxRunOptions, SandboxSession } from "eve/sandbox";
import {
  boundedRun,
  REPOSITORY_OPERATION_TIMEOUT_MS,
  TIMED_OUT_EXIT_CODE,
} from "./sandbox-deadline.js";

const TIMED_OUT_MESSAGE = /timed out after 5ms/;

const ok = () =>
  Promise.resolve({ exitCode: 0, stderr: "", stdout: "finished" });

/** Records what reached `run` so the composed signal can be asserted on. */
const fakeSandbox = (run: (options: SandboxRunOptions) => Promise<unknown>) => {
  const commands: SandboxRunOptions[] = [];
  const sandbox = {
    run: (options: SandboxRunOptions) => {
      commands.push(options);
      return run(options);
    },
  } as unknown as SandboxSession;
  return { commands, sandbox };
};

/** A command that never returns until its own deadline aborts it. */
const hangs = (options: SandboxRunOptions) =>
  new Promise<never>((_resolve, reject) => {
    options.abortSignal?.addEventListener("abort", () =>
      reject(options.abortSignal?.reason)
    );
  });

describe("boundedRun", () => {
  it("bounds every repository operation at five minutes by default", () => {
    assert.equal(REPOSITORY_OPERATION_TIMEOUT_MS, 300_000);
  });

  it("passes an unaborted deadline signal to the command", async () => {
    const { commands, sandbox } = fakeSandbox(ok);
    const result = await boundedRun(sandbox, { command: "git fetch" }, 5000);
    assert.equal(result.exitCode, 0);
    assert.equal(commands[0]?.abortSignal?.aborted, false);
  });

  it("reports a stalled command as a non-zero result, not a throw", async () => {
    const { sandbox } = fakeSandbox(hangs);
    const result = await boundedRun(sandbox, { command: "git push" }, 5);
    assert.equal(result.exitCode, TIMED_OUT_EXIT_CODE);
    assert.match(result.stderr, TIMED_OUT_MESSAGE);
    assert.equal(result.stdout, "");
  });

  it("rethrows a cancelled turn instead of reporting a timeout", async () => {
    const cancelled = new Error("turn cancelled");
    const { sandbox } = fakeSandbox(() => Promise.reject(cancelled));
    await assert.rejects(
      boundedRun(sandbox, { command: "git fetch" }, 300_000),
      (error: unknown) => error === cancelled
    );
  });

  it("rethrows an ordinary failure that is not the deadline", async () => {
    const failure = new Error("sandbox gone");
    const { sandbox } = fakeSandbox(() => Promise.reject(failure));
    await assert.rejects(
      boundedRun(sandbox, { command: "git fetch" }, 300_000),
      (error: unknown) => error === failure
    );
  });
});

const TOOL_ROOTS = ["agent/tools", "agent/subagents"];
const RAW_RUN = /\bsandbox\.run\(/u;
const GIT_COMMAND = /git -C /u;

/** Every authored tool file under the given roots, recursively. */
const toolFiles = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return toolFiles(full);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [full]
      : [];
  });

describe("authored sandbox git tools", () => {
  it("runs every git command through boundedRun", () => {
    const unbounded = TOOL_ROOTS.flatMap(toolFiles)
      .map((file) => ({ file, source: readFileSync(file, "utf8") }))
      .filter(({ source }) => GIT_COMMAND.test(source) && RAW_RUN.test(source))
      .map(({ file }) => file);
    assert.deepEqual(
      unbounded,
      [],
      `These tools run git in the sandbox without a deadline: ${unbounded.join(", ")}`
    );
  });
});
