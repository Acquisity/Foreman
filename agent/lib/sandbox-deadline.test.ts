import assert from "node:assert/strict";
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
