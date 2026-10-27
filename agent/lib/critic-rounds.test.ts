import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import { followUpDispatch, STATUS_ONLY_FOLLOW_UP } from "../channels/linear.js";
import {
  type CriticCount,
  type CriticRounds,
  criticBlocked,
  reviewCycleAfterDecision,
  routeRefusal,
  settleCriticPacket,
  settleCriticRound,
  stampCriticPacket,
} from "./triage-log.js";
import { isStatusFollowUp } from "./trust.js";

const FIRST_LINE_RULE = /Source issue: ENG-1/u;
const TWICE_RULE = /objected to ENG-1 twice/u;

const duplicate = {
  classification: "Bug",
  closureReview: true,
  issue: "ENG-1",
  outcome: "route" as const,
  path: "Duplicate",
};
const decisions = { "ENG-1": duplicate };
const routeInput = { duplicateOf: "ENG-9", issue: "ENG-1", state: "Duplicate" };

type Step = "decide" | CriticCount;
const run = (steps: Step[]): Record<string, CriticRounds> =>
  steps.reduce<Record<string, CriticRounds>>(
    (rounds, step) =>
      step === "decide"
        ? reviewCycleAfterDecision(rounds, "ENG-1")
        : settleCriticRound(rounds, "ENG-1", step),
    {}
  );

describe("the review cycle", () => {
  it("does not let an earlier approval clear a newly decided closure", () => {
    const approved = run(["decide", "approve"]);
    assert.equal(routeRefusal(decisions, approved, routeInput), null);
    const redecided = run(["decide", "approve", "decide"]);
    assert.match(
      routeRefusal(decisions, redecided, routeInput) ?? "",
      FIRST_LINE_RULE
    );
    assert.equal(
      routeRefusal(
        decisions,
        run(["decide", "approve", "decide", "approve"]),
        routeInput
      ),
      null
    );
  });

  it("keeps the first objection through the adjudication, so a second one blocks", () => {
    const adjudicated = run(["decide", "objection", "decide"]);
    assert.equal(adjudicated["ENG-1"].objections, 1);
    assert.match(
      routeRefusal(decisions, adjudicated, routeInput) ?? "",
      FIRST_LINE_RULE
    );
    const blocked = run(["decide", "objection", "decide", "objection"]);
    assert.equal(criticBlocked(blocked, "ENG-1"), true);
  });

  it("routes a first objection settled after a failed review without a third review", () => {
    const settled = run(["decide", "failed", "decide", "objection", "decide"]);
    assert.equal(criticBlocked(settled, "ENG-1"), false);
    assert.equal(routeRefusal(decisions, settled, routeInput), null);
  });

  it("reviews a new decision after two failed reviews, or after an adjudicated one was settled", () => {
    for (const steps of [
      ["decide", "failed", "failed", "decide"],
      ["decide", "failed", "decide", "objection", "decide", "decide"],
      ["decide", "objection", "decide", "decide"],
    ] as Step[][]) {
      const rounds = run(steps);
      assert.equal(rounds["ENG-1"].reviews, 0, steps.join(" "));
      assert.match(
        routeRefusal(decisions, rounds, routeInput) ?? "",
        FIRST_LINE_RULE,
        steps.join(" ")
      );
    }
  });

  it("ignores a critic result that was dispatched for an earlier decision", () => {
    const sent = {
      commit: "c".repeat(40),
      documentId: "doc-1",
      issue: "ENG-1",
      updatedAt: "2026-10-27T10:00:00.000Z",
    };
    const decidedA = run(["decide"]);
    const packetA = stampCriticPacket(decidedA, sent);
    const decidedB = reviewCycleAfterDecision(decidedA, "ENG-1");
    for (const counted of ["approve", "objection", "failed"] as const) {
      const settled = settleCriticPacket(decidedB, packetA, counted);
      assert.equal(settled.stale, true, counted);
      assert.deepEqual(settled.rounds, decidedB, counted);
      assert.match(
        routeRefusal(decisions, settled.rounds, routeInput) ?? "",
        FIRST_LINE_RULE,
        counted
      );
    }
    const packetB = stampCriticPacket(decidedB, sent);
    const reviewed = settleCriticPacket(decidedB, packetB, "approve");
    assert.equal(reviewed.stale, false);
    assert.equal(routeRefusal(decisions, reviewed.rounds, routeInput), null);
  });

  it("counts a result dispatched before its adjudication as that cycle's review", () => {
    const decided = run(["decide"]);
    const first = settleCriticPacket(
      decided,
      stampCriticPacket(decided, {
        commit: null,
        documentId: null,
        issue: "ENG-1",
        updatedAt: null,
      }),
      "objection"
    );
    const adjudicated = reviewCycleAfterDecision(first.rounds, "ENG-1");
    const second = settleCriticPacket(
      adjudicated,
      stampCriticPacket(adjudicated, {
        commit: null,
        documentId: null,
        issue: "ENG-1",
        updatedAt: null,
      }),
      "objection"
    );
    assert.equal(first.stale || second.stale, false);
    assert.equal(criticBlocked(second.rounds, "ENG-1"), true);
    assert.equal(second.rounds["ENG-1"].generation, 2);
    const late = stampCriticPacket(adjudicated, {
      commit: null,
      documentId: null,
      issue: "ENG-1",
      updatedAt: null,
    });
    const next = reviewCycleAfterDecision(
      settleCriticPacket(adjudicated, late, "approve").rounds,
      "ENG-1"
    );
    assert.equal(settleCriticPacket(next, late, "approve").stale, true);
  });

  it("starts a new cycle when a blocked ticket gets a new decision, still reviewed before it routes", () => {
    const fresh = run(["decide", "objection", "decide", "objection", "decide"]);
    assert.equal(criticBlocked(fresh, "ENG-1"), false);
    assert.match(
      routeRefusal(decisions, fresh, routeInput) ?? "",
      FIRST_LINE_RULE
    );
  });

  it("lets a person's status-only request through a block, and nothing else", () => {
    const blocked = run(["decide", "objection", "decide", "objection"]);
    const done = { issue: "ENG-1", state: "Done" };
    assert.match(routeRefusal(decisions, blocked, done) ?? "", TWICE_RULE);
    assert.equal(
      routeRefusal(decisions, blocked, done, { statusRequest: true }),
      null
    );
    assert.equal(
      routeRefusal(decisions, run(["decide"]), done, { statusRequest: true }),
      null
    );
    assert.match(
      routeRefusal(
        decisions,
        blocked,
        { ...done, addLabels: ["Bug"] },
        { statusRequest: true }
      ) ?? "",
      TWICE_RULE
    );
  });

  it("stamps exactly the turn that gets the status-only instruction", () => {
    const auth: SessionAuthContext = {
      attributes: {},
      authenticator: "test",
      principalId: "user:1",
      principalType: "user",
    };
    for (const [outcome, widget, stamped] of [
      ["status", false, true],
      ["status", true, false],
      ["respond", false, false],
      [null, false, false],
    ] as const) {
      const dispatched = followUpDispatch(auth, ["ticket"], outcome, widget);
      assert.equal(isStatusFollowUp(dispatched.auth), stamped, `${outcome}`);
      assert.equal(
        dispatched.context.includes(STATUS_ONLY_FOLLOW_UP),
        stamped,
        `${outcome}`
      );
    }
    assert.equal(isStatusFollowUp(auth), false);
    assert.equal(isStatusFollowUp(null), false);
  });
});
