import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isPipelineReady,
  isStalePipelineEvent,
  mergeFeedbackIds,
  nextBlockerRepeatCount,
  pipelineRunKey,
  terminalPipelineState,
} from "./pipeline-runs.js";

describe("pipeline stabilization state", () => {
  it("rejects stale heads and deduplicates feedback", () => {
    assert.equal(isStalePipelineEvent("a".repeat(40), "b".repeat(40)), true);
    assert.equal(isStalePipelineEvent("a".repeat(40), "a".repeat(40)), false);
    assert.deepEqual(mergeFeedbackIds(["review:1"], ["review:1", "check:2"]), [
      "review:1",
      "check:2",
    ]);
  });

  it("escalates only on the third unchanged blocker record", () => {
    const blocker = ["ci:test failed"];
    const first = nextBlockerRepeatCount([], 0, blocker);
    const second = nextBlockerRepeatCount(blocker, first, blocker);
    const third = nextBlockerRepeatCount(blocker, second, blocker);
    assert.deepEqual([first, second, third], [1, 2, 3]);
    assert.equal(nextBlockerRepeatCount(blocker, third, ["review:bug"]), 1);
  });

  it("requires every readiness condition", () => {
    const ready = {
      actionableFeedbackRemaining: false,
      blockers: [],
      checksPassed: true,
      internalApproved: true,
      mergeable: true,
      requested: true,
    };
    assert.equal(isPipelineReady(ready), true);
    assert.equal(isPipelineReady({ ...ready, checksPassed: false }), false);
    assert.equal(isPipelineReady({ ...ready, blockers: ["conflict"] }), false);
  });

  it("scopes run keys to repository and source", () => {
    assert.notEqual(
      pipelineRunKey("Acquisity/Foreman", "pr:12"),
      pipelineRunKey("Acquisity/Other", "pr:12")
    );
  });

  it("ends a run terminal when its pull request is merged", () => {
    // A merged PR is delivered whether or not the independent reviewer
    // certified the head, so merge short-circuits the readiness gate and
    // reaches the non-active `ready` status the reconcile schedule skips.
    assert.deepEqual(terminalPipelineState(false, false, true, "stabilizing"), {
      stage: "ready",
      status: "ready",
    });
    assert.deepEqual(terminalPipelineState(false, false, true, "ready"), {
      stage: "ready",
      status: "ready",
    });
  });

  it("keeps an open, uncertified run active", () => {
    assert.deepEqual(
      terminalPipelineState(false, false, false, "stabilizing"),
      {
        stage: "stabilizing",
        status: "active",
      }
    );
    assert.deepEqual(terminalPipelineState(true, false, false, "stabilizing"), {
      stage: "ready",
      status: "ready",
    });
    assert.deepEqual(terminalPipelineState(false, true, false, "stabilizing"), {
      stage: "escalated",
      status: "escalated",
    });
  });
});
