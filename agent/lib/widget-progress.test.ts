import assert from "node:assert/strict";
import { test } from "node:test";
import { planWidgetChecks, progressFromEvents } from "./widget-progress.js";

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
test("planned checks lead in order until a real call replaces them; unplanned calls follow", () => {
  const reduce = progressFromEvents(["inboxes", "campaigns"]);
  assert.deepEqual(reduce(start(1, ["a"]))?.checks, [
    { id: "inboxes", status: "planned" },
    { id: "campaigns", status: "running" },
  ]);
  assert.deepEqual(
    reduce({
      data: {
        actions: [{ callId: "b", toolName: "widget_billing_summary" }],
        sequence: 2,
      },
      type: "actions.requested",
    })?.checks,
    [
      { id: "inboxes", status: "planned" },
      { id: "campaigns", status: "running" },
      { id: "billing", status: "running" },
    ]
  );
});
test("the plan keeps the likely checks, most likely first, and is empty on any failure", async () => {
  const answers = { billing: 0.9, campaigns: 0.2, inboxes: 0.7 };
  const fetch = () =>
    Promise.resolve({
      json: () =>
        Promise.resolve({
          answers: Object.fromEntries(
            Object.entries(answers).map(([id, noul]) => [id, { noul }])
          ),
        }),
      ok: true,
      status: 200,
    });
  assert.deepEqual(
    await planWidgetChecks("Why was I charged twice?", { apiKey: "k", fetch }),
    ["billing", "inboxes"]
  );
  assert.deepEqual(
    await planWidgetChecks("x", {
      apiKey: "k",
      fetch: () => Promise.reject(new Error("down")),
    }),
    []
  );
  assert.deepEqual(await planWidgetChecks("x", { apiKey: "" }), []);
});
