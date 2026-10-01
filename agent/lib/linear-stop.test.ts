import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POST } from "eve/channels";
import type {
  LinearAgentSessionEvent,
  LinearChannel,
  LinearSessionContext,
} from "eve/channels/linear";
import { parseLinearWebhookEvent } from "eve/channels/linear";

process.env.LINEAR_CONNECTOR ??= "stub/stub";
const { onAgentSession, withLinearStop } = await import(
  "../channels/linear.js"
);

const stopBody = JSON.stringify({
  action: "prompted",
  agentActivity: {
    content: { body: "", type: "prompt" },
    id: "a1",
    signal: "stop",
  },
  agentSession: { id: "s1" },
  type: "AgentSessionEvent",
});

/** Runs a stop delivery through the wrapped route and reports what it did. */
const deliver = async (body: string, status: number, reset = "reset") => {
  const calls: string[] = [];
  const posted: string[] = [];
  const pending: Promise<unknown>[] = [];
  const inner = {
    routes: [
      POST("/linear", () => Promise.resolve(new Response(null, { status }))),
    ],
  } as unknown as LinearChannel;
  const [route] = withLinearStop(inner, (input) => {
    const { content } = input.activity;
    posted.push("body" in content ? content.body : "");
    return Promise.resolve({ id: "x", success: true });
  }).routes;
  const args = {
    from: (token: string) => ({
      reset: () => {
        calls.push(token);
        return Promise.resolve({ previousSessionId: "eve1", status: reset });
      },
    }),
    waitUntil: (task: Promise<unknown>) => pending.push(task),
  };
  // biome-ignore lint/suspicious/noExplicitAny: a minimal route harness.
  await (route as any).handler(
    new Request("http://x/linear", { body, method: "POST" }),
    args
  );
  await Promise.all(pending);
  return { calls, posted };
};

describe("withLinearStop", () => {
  it("resets the exact session and confirms a verified Stop", async () => {
    assert.deepEqual(await deliver(stopBody, 200), {
      calls: ["agent-session:s1"],
      posted: ["Stopped."],
    });
  });

  it("says so when nothing was running", async () => {
    const { posted } = await deliver(stopBody, 200, "no_active_session");
    assert.deepEqual(posted, ["Nothing was running."]);
  });

  it("ignores an unverified delivery", async () => {
    assert.deepEqual(await deliver(stopBody, 401), { calls: [], posted: [] });
  });

  it("acknowledges an unparseable verified body untouched", async () => {
    assert.deepEqual(await deliver("not json", 200), { calls: [], posted: [] });
  });

  it("leaves ordinary prompts to the queue", async () => {
    const prompt = stopBody.replace('"signal":"stop"', '"signal":null');
    assert.deepEqual(await deliver(prompt, 200), { calls: [], posted: [] });
  });

  it("keeps the Stop prompt from reaching the model", async () => {
    const event = parseLinearWebhookEvent({
      body: stopBody,
      headers: new Headers(),
    });
    assert.equal(event?.kind, "agent_session");
    assert.equal(
      await onAgentSession(
        {} as LinearSessionContext,
        event as LinearAgentSessionEvent
      ),
      null
    );
  });
});
