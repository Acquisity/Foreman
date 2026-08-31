import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { default: rootAgent } = await import("./agent.js");

describe("root agent limits", () => {
  it("disables the default 40M per-session input budget and nothing else", () => {
    // Cached prompt re-reads count as provider-reported input on every model
    // call, so eve's default input budget can park a long Slack thread on an
    // Approve/Stop card the channel cannot answer. Pin the exact object so no
    // other limit (output cap, session timeout) gets configured by accident.
    assert.deepEqual(rootAgent.limits, { maxInputTokensPerSession: false });
  });
});
