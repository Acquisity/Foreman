import assert from "node:assert/strict";
import { test } from "node:test";
import { progressFromEvents } from "./widget-progress.js";

const start = (sequence: number, ids: string[]) => ({
  data: {
    actions: ids.map((callId) => ({
      callId,
      input: { secret: "private" },
      toolName: "widget_outreach_health",
    })),
    sequence,
  },
  type: "actions.requested",
});
const result = (sequence: number, callId: string, output: unknown) => ({
  data: { result: { callId, kind: "tool-result", output }, sequence },
  type: "action.result",
});
test("parallel repeated checks stay running until all finish; replay is idempotent", () => {
  const reduce = progressFromEvents();
  const first = reduce(start(1, ["a", "b"]));
  assert.deepEqual(reduce(start(1, ["a", "b"]))?.checks, first?.checks);
  assert.equal(reduce(result(2, "a", {}))?.checks[0].status, "running");
  assert.equal(
    reduce(result(3, "b", { success: false }))?.checks[0].status,
    "unavailable"
  );
  assert.equal(JSON.stringify(first).includes("private"), false);
});
test("unknown tools and arbitrary output never become customer-facing labels or findings", () => {
  const reduce = progressFromEvents();
  reduce(start(1, ["a"]));
  const progress = reduce(
    result(2, "a", { domain: "private.example", text: "customer@example.com" })
  );
  assert.deepEqual(progress?.checks, [
    { id: "campaigns", status: "completed" },
  ]);
  assert.equal(reduce(result(3, "unknown", {})), null);
});
