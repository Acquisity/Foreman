import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFinCallback,
  deliverFinCallback,
  isFinCallbackUrl,
  reduceFinEvent,
} from "./fin-investigation-callback.js";

const callback = "https://api.intercom.io/hooks/procedures/callback/callback-1";

test("accepts only exact Intercom Procedure callback URLs", () => {
  assert.equal(isFinCallbackUrl(callback), true);
  for (const value of [
    "https://example.com/hooks/procedures/callback/callback-1",
    `${callback}?redirect=other`,
    "https://api.intercom.io/other/callback-1",
    "https://user:pass@api.intercom.io/hooks/procedures/callback/callback-1",
  ]) {
    assert.equal(isFinCallbackUrl(value), false);
  }
});

test("delivers one bounded customer-safe result with a deadline", async () => {
  const state = createFinCallback(callback);
  assert.ok(state);
  const calls: Array<{ input?: RequestInit; url: string }> = [];
  const request = ((url, input) => {
    calls.push({ input, url: String(url) });
    return Promise.resolve(new Response(null, { status: 200 }));
  }) satisfies typeof fetch;
  const outcome = {
    message: "Verified-workspace result.",
    status: "completed" as const,
  };
  await deliverFinCallback(state, "session-1", outcome, request);
  await deliverFinCallback(state, "session-1", outcome, request);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, callback);
  assert.ok(calls[0]?.input?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(calls[0]?.input?.body)), {
    message: "Verified-workspace result.",
    status: "completed",
  });
});

test("reduces only complete final model messages into a successful outcome", () => {
  const toolCall = reduceFinEvent("", {
    finishReason: "tool-calls",
    message: "Intermediate",
    type: "message.completed",
  });
  const truncated = reduceFinEvent(toolCall.answer, {
    finishReason: "length",
    message: "Partial",
    type: "message.completed",
  });
  const completed = reduceFinEvent(truncated.answer, {
    finishReason: "stop",
    message: " Final answer. ",
    type: "message.completed",
  });
  assert.deepEqual(
    reduceFinEvent(completed.answer, { type: "session.completed" }).outcome,
    { message: "Final answer.", status: "completed" }
  );
  assert.deepEqual(
    reduceFinEvent(truncated.answer, { type: "session.completed" }).outcome,
    {
      message:
        "The investigation could not be completed. No findings are available.",
      status: "failed",
    }
  );
});
