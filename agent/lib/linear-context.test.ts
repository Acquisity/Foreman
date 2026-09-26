import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LinearAgentSessionEvent } from "eve/channels/linear";

const { buildLinearContext, LINEAR_TRIAGE_ROUTE } = await import(
  "./linear-context.js"
);

function makeEvent(overrides: {
  action: string;
  issue?: { id: string } | null;
  requester?: { id: string; displayName?: string; name?: string };
}): LinearAgentSessionEvent {
  return {
    action: overrides.action,
    agentSession: {
      id: "session-1",
      ...(overrides.issue === undefined ? {} : { issue: overrides.issue }),
    },
    delivery: { event: undefined, id: undefined },
    kind: "agent_session",
    previousComments: [],
    raw: {},
    ...(overrides.requester
      ? {
          agentActivity: {
            content: {},
            id: "activity-1",
            user: overrides.requester,
          },
        }
      : {}),
  };
}

describe("buildLinearContext", () => {
  it("points every created and prompted dispatch at triage for customer reports", () => {
    for (const action of ["created", "prompted"]) {
      const context = buildLinearContext(
        makeEvent({ action, issue: { id: "issue-1" } })
      );
      assert.deepEqual(context, [LINEAR_TRIAGE_ROUTE]);
    }
  });

  it("leaves the follow-up decision to reply_to_requester and keeps other comments out of the thread", () => {
    for (const rule of [
      "pass your answer to reply_to_requester",
      "returns posted false with an outcome, post nothing",
      "A result with an error is a failed delivery",
      "Never comment under the Slack thread comment any other way",
    ]) {
      assert.ok(LINEAR_TRIAGE_ROUTE.includes(rule), rule);
    }
  });

  it("returns null for unsupported actions", () => {
    assert.equal(buildLinearContext(makeEvent({ action: "updated" })), null);
  });

  it("includes the requester name as context when Linear provides it", () => {
    const context = buildLinearContext(
      makeEvent({
        action: "created",
        issue: { id: "issue-1" },
        requester: { displayName: "Ada Lovelace", id: "user-1" },
      })
    );
    assert.ok(context);
    assert.ok(context.includes("The requesting user is Ada Lovelace."));
  });
});
