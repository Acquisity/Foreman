import assert from "node:assert/strict";
import { test } from "node:test";
import type { SandboxSelectorContext } from "eve/sandbox";
import type { VercelSandboxSession } from "eve/sandbox/vercel";
import { verifiedWidgetContext } from "./lib/widget.fixture.js";
import { widgetAuth } from "./lib/widget-scope.js";
import selectSandbox, {
  environment,
  sandboxSessionOptions,
} from "./sandbox.js";

const SAFE_DIRECTORY_FAILURE =
  /Failed to mark \/workspace as a safe git directory \(exit 128\): denied/u;

const selectorContext = (initiator: unknown) =>
  ({
    session: { auth: { initiator }, id: "session-1", turn: {} },
  }) as unknown as SandboxSelectorContext;

const fakeSandbox = (exitCode: number) => {
  const runs: { abortSignal?: AbortSignal; command: string }[] = [];
  const sandbox = {
    run: (options: { abortSignal?: AbortSignal; command: string }) => {
      runs.push(options);
      return Promise.resolve({ exitCode, stderr: "denied", stdout: "" });
    },
  } as unknown as VercelSandboxSession;
  return { runs, sandbox };
};

test("customer investigations receive a deny-all sandbox network policy", () => {
  assert.deepEqual(sandboxSessionOptions(widgetAuth(verifiedWidgetContext)), {
    networkPolicy: "deny-all",
  });
  assert.equal(sandboxSessionOptions(null), undefined);
});

test("the selector opens with deny-all for widget support and no options otherwise", async (t) => {
  const { runs, sandbox } = fakeSandbox(0);
  const open = t.mock.method(environment, "open", () =>
    Promise.resolve(sandbox)
  );

  assert.equal(
    await selectSandbox(selectorContext(widgetAuth(verifiedWidgetContext))),
    sandbox
  );
  assert.equal(await selectSandbox(selectorContext(null)), sandbox);

  assert.deepEqual(
    open.mock.calls.map((call) => call.arguments[0]),
    [{ networkPolicy: "deny-all" }, undefined]
  );
  assert.deepEqual(
    runs.map((run) => run.command),
    [
      "git config --global --add safe.directory /workspace",
      "git config --global --add safe.directory /workspace",
    ]
  );
  // boundedRun attaches its deadline signal to every command.
  assert.ok(runs.every((run) => run.abortSignal instanceof AbortSignal));
});

test("the selector throws when /workspace cannot be marked safe", async (t) => {
  const { sandbox } = fakeSandbox(128);
  t.mock.method(environment, "open", () => Promise.resolve(sandbox));

  await assert.rejects(
    async () => await selectSandbox(selectorContext(null)),
    SAFE_DIRECTORY_FAILURE
  );
});
