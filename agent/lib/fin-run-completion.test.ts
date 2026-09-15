import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedFinContext as scope } from "./fin-investigation.fixture.js";
import { finishFinRun } from "./fin-run-completion.js";
import type { FinRun } from "./fin-run-store.js";

test("human takeover still persists completion and delivers internally, with no customer callback", async () => {
  let saved = false;
  let deliveredInternally = false;
  const outcome = {
    message: "Confirmed report with ticket.",
    status: "completed" as const,
  };
  const run: FinRun = {
    callback_attempts: 0,
    callback_delivered: false,
    callback_url: "https://api.intercom.io/hooks/procedures/callback/one",
    completed_at: new Date(),
    created_at: new Date(),
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    outcome,
    scope,
    session_id: "session-1",
    slack: null,
  };
  await finishFinRun(run.id, "session-1", null, outcome, {
    attach: async () => undefined,
    callback: () => assert.fail("takeover must not notify the customer"),
    complete: () => {
      saved = true;
      return Promise.resolve(run);
    },
    inspect: async () => ({ humanReplied: true, requestKey: "native-message" }),
    mark: () => assert.fail("no signal was delivered"),
    reserve: () => assert.fail("takeover must not reserve a signal"),
    slack: (_receipt, report) => {
      assert.deepEqual(report, outcome);
      deliveredInternally = true;
      return Promise.resolve();
    },
  });
  assert.equal(saved, true);
  assert.equal(deliveredInternally, true);
});
