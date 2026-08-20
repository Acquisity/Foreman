import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LinearAgentSessionEvent } from "eve/channels/linear";

const { buildLinearContext } = await import("./linear-context.js");

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
  it("adds no context for created and prompted dispatches", () => {
    for (const action of ["created", "prompted"]) {
      const context = buildLinearContext(
        makeEvent({ action, issue: { id: "issue-1" } })
      );
      assert.deepEqual(context, []);
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
