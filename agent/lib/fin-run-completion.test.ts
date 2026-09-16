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

for (const failure of [
  "none",
  "complete",
  "inspect",
  "callback",
  "reserved",
] as const) {
  test(`completion keeps internal delivery independent when ${failure} fails`, async () => {
    let internal = 0;
    let saved = 0;
    let signalled = 0;
    let marked = 0;
    const outcome = { message: "Report", status: "completed" as const };
    await finishFinRun(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "session-1",
      null,
      outcome,
      {
        callback: (state) => {
          signalled += 1;
          if (failure === "callback") {
            return Promise.resolve();
          }
          if (state) {
            state.delivered = true;
          }
          return Promise.resolve();
        },
        complete: (id, report, sessionId) => {
          assert.equal(sessionId, "session-1");
          if (failure === "complete") {
            return Promise.reject(new Error("database unavailable"));
          }
          saved += 1;
          return Promise.resolve({
            callback_attempts: 0,
            callback_delivered: false,
            callback_url:
              "https://api.intercom.io/hooks/procedures/callback/one",
            completed_at: new Date(),
            created_at: new Date(),
            id,
            outcome: report,
            scope,
            session_id: sessionId,
            slack: null,
          });
        },
        inspect: () => {
          if (failure === "inspect") {
            return Promise.reject(new Error("native history unavailable"));
          }
          return Promise.resolve({
            humanReplied: false,
            requestKey: "native-message",
          });
        },
        mark: () => {
          marked += 1;
          return Promise.resolve();
        },
        reserve: async () => failure !== "reserved",
        slack: () => {
          internal += 1;
          return Promise.resolve();
        },
      }
    );
    assert.equal(internal, 1);
    assert.equal(saved, failure === "complete" ? 0 : 1);
    assert.equal(signalled, ["none", "callback"].includes(failure) ? 1 : 0);
    assert.equal(marked, failure === "none" ? 1 : 0);
  });
}
