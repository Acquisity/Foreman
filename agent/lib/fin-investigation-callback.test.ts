import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFinCallback,
  deliverFinCallback,
  isFinCallbackUrl,
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
  state.answer = "Verified-workspace result.";
  const calls: Array<{ input?: RequestInit; url: string }> = [];
  const request = ((url, input) => {
    calls.push({ input, url: String(url) });
    return Promise.resolve(new Response(null, { status: 200 }));
  }) satisfies typeof fetch;
  await deliverFinCallback(state, "session-1", "completed", request);
  await deliverFinCallback(state, "session-1", "completed", request);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, callback);
  assert.ok(calls[0]?.input?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(calls[0]?.input?.body)), {
    message: "Verified-workspace result.",
    status: "completed",
  });
});
