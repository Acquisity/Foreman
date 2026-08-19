import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LinearAgentSessionEvent } from "eve/channels/linear";

// linear-context.ts reads LINEAR_CONNECTOR at module load.
process.env.LINEAR_CONNECTOR = "linear/foreman-agent";

const { LINEAR_INTAKE_TASK, buildLinearContext } = await import(
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
  it("includes the intake task when created with an issue", () => {
    const context = buildLinearContext(
      makeEvent({ action: "created", issue: { id: "issue-1" } })
    );
    assert.ok(context);
    assert.ok(context.includes(LINEAR_INTAKE_TASK));
  });

  it("omits the intake task when created without an issue (undefined)", () => {
    const context = buildLinearContext(makeEvent({ action: "created" }));
    assert.ok(context);
    assert.ok(!context.includes(LINEAR_INTAKE_TASK));
  });

  it("omits the intake task when created with a null issue", () => {
    const context = buildLinearContext(
      makeEvent({ action: "created", issue: null })
    );
    assert.ok(context);
    assert.ok(!context.includes(LINEAR_INTAKE_TASK));
  });

  it("omits the intake task when prompted with an issue", () => {
    const context = buildLinearContext(
      makeEvent({ action: "prompted", issue: { id: "issue-1" } })
    );
    assert.ok(context);
    assert.ok(!context.includes(LINEAR_INTAKE_TASK));
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
