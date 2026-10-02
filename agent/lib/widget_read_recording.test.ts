import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  invokeProvider,
  type ProviderContext,
} from "#lib/executor/dispatch.js";
import { executorTransport } from "#lib/executor/transport.js";
import { verifiedWidgetContext } from "#lib/widget.fixture.js";
import { widgetAuth } from "#lib/widget-scope.js";
import definition, { readRecording } from "../tools/widget_read_recording.js";

const originalConnector = process.env.EXECUTOR_MCP_CONNECTOR;
process.env.EXECUTOR_MCP_CONNECTOR = "executor.test/widget";
after(() => {
  if (originalConnector === undefined) {
    delete process.env.EXECUTOR_MCP_CONNECTOR;
  } else {
    process.env.EXECUTOR_MCP_CONNECTOR = originalConnector;
  }
});

const jamId = "0f3c9d6e-1b2a-4c5d-8e9f-a0b1c2d3e4f5";
const withRecording = { ...verifiedWidgetContext, recordingId: jamId };
const OWN_ONLY = /own screen recording/;
const OUTSIDE = /outside the support widget toolkit/;
const context = (scope: typeof verifiedWidgetContext) =>
  ({
    abortSignal: new AbortController().signal,
    getToken: () => Promise.resolve({ token: "test-token" }),
    session: { auth: { current: null, initiator: widgetAuth(scope) } },
  }) as unknown as ProviderContext;
const ctx = context(withRecording);

test("the tool is offered only on a turn that carries a recording", () => {
  const offered = (scope: typeof verifiedWidgetContext) =>
    definition.events["step.started"]?.({} as never, context(scope) as never);
  assert.ok(offered(withRecording));
  assert.equal(offered(verifiedWidgetContext), null);
});

test("reads every part of the bound recording and bounds what comes back", async (t) => {
  const call = t.mock.method(executorTransport, "call", async () => ({
    data: { content: [{ text: "x".repeat(10_000), type: "text" }] },
    ok: true,
  }));
  const result = (await readRecording(ctx, jamId)) as Record<string, unknown>;
  assert.equal(call.mock.callCount(), 5);
  for (const [, path, input] of call.mock.calls.map(
    (c) => c.arguments as unknown as [unknown, string, { jamId: string }]
  )) {
    assert.ok(path.startsWith("jam.user.personalJam."));
    assert.equal(input.jamId, jamId);
  }
  assert.ok(String(result.consoleErrors).length <= 3001);
  assert.deepEqual(result.unavailable, []);
});

test("a recording that cannot be read says so instead of failing the turn", async (t) => {
  t.mock.method(executorTransport, "call", () =>
    Promise.reject(new Error("Jam is down"))
  );
  assert.deepEqual(await readRecording(ctx, jamId), {
    error: "The screen recording could not be read.",
  });
});

test("a part that fails is listed as unavailable", async (t) => {
  t.mock.method(
    executorTransport,
    "call",
    async (_wire: unknown, path: string) =>
      path.endsWith("getvideotranscript")
        ? { error: { code: "not_found", status: 404 }, ok: false }
        : { data: { content: [{ text: "ok", type: "text" }] }, ok: true }
  );
  const result = (await readRecording(ctx, jamId)) as Record<string, unknown>;
  assert.deepEqual(result.unavailable, ["transcript"]);
  assert.equal(result.details, "ok");
});

test("no other recording can be read, and none without a bound one", async (t) => {
  const call = t.mock.method(executorTransport, "call", async () => ({
    data: null,
    ok: true,
  }));
  await assert.rejects(
    invokeProvider(ctx, "jam.user.personalJam.getdetails", { jamId: "other" }),
    OWN_ONLY
  );
  await assert.rejects(
    invokeProvider(
      context(verifiedWidgetContext),
      "jam.user.personalJam.getdetails",
      {
        jamId,
      }
    ),
    OWN_ONLY
  );
  // Jam listing and search stay outside the lane entirely.
  await assert.rejects(
    invokeProvider(ctx, "jam.user.personalJam.listjams", {}),
    OUTSIDE
  );
  assert.equal(call.mock.callCount(), 0);
});
