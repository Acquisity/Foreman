import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planReply, type ThreadComment } from "./requester-reply.js";
import {
  closureHeld,
  deliveryKey,
  type LatestTriageDecision,
} from "./triage-log.js";

const FOREMAN = "foreman";
const ISSUE = "ENG-1";

const anchor: ThreadComment = {
  body: "Slack thread connected in [#acquisity-comms-feedback](https://x.slack.com/archives/C1/p1)",
  createdAt: "2026-11-02T09:00:00Z",
  id: "anchor",
  parentId: null,
  userId: "aaron",
};
const said = (
  id: string,
  userId: string,
  createdAt: string
): ThreadComment => ({
  body: "text",
  createdAt,
  id,
  parentId: "anchor",
  userId,
});

const decided = (decidedAt: string): LatestTriageDecision => ({
  classification: "User Error",
  decidedAt,
  issue: ISSUE,
  outcome: "route",
  path: "User Error",
});

describe("reply before close across a correction (R2, R3)", () => {
  it("sends A, corrects to B with the same class and path, sends B once, then closes", () => {
    const asked = [anchor, said("q", "rep", "2026-11-02T09:05:00Z")];
    const a = decided("2026-11-02T10:00:00Z");
    let replies: Record<string, string> = {};

    const first = planReply(asked, FOREMAN, a.decidedAt);
    assert.equal(first.ok, true);
    const sentA = said("a", FOREMAN, "2026-11-02T10:01:00Z");
    const keyA = deliveryKey(a, { issue: ISSUE, posted: true });
    assert.ok(keyA);
    replies = { [ISSUE]: keyA };
    assert.equal(closureHeld({ [ISSUE]: a }, replies, ISSUE, true), false);

    const b = decided("2026-11-02T10:05:00Z");
    assert.equal(closureHeld({ [ISSUE]: b }, replies, ISSUE, true), true);

    const second = planReply([...asked, sentA], FOREMAN, b.decidedAt);
    assert.ok(second.ok, "the corrected decision may reply once");
    assert.equal(second.ok && second.followUp, null);
    const keyB = deliveryKey(b, { issue: ISSUE, posted: true });
    assert.ok(keyB);
    replies = { [ISSUE]: keyB };
    assert.equal(closureHeld({ [ISSUE]: b }, replies, ISSUE, true), false);

    const sentB = said("b", FOREMAN, "2026-11-02T10:06:00Z");
    const third = planReply([...asked, sentA, sentB], FOREMAN, b.decidedAt);
    assert.equal(third.ok, false, "only one reply per decision");
  });

  it("keeps a failed corrected send held, even when the class and path did not change", () => {
    const a = decided("2026-11-02T10:00:00Z");
    const keyA = deliveryKey(a, { issue: ISSUE, posted: true });
    assert.ok(keyA);
    const b = decided("2026-11-02T10:05:00Z");
    assert.equal(deliveryKey(b, { posted: false }), null);
    assert.equal(
      closureHeld({ [ISSUE]: b }, { [ISSUE]: keyA }, ISSUE, true),
      true
    );
  });

  it("still refuses a second post when no newer decision asks for one", () => {
    const thread = [
      anchor,
      said("q", "rep", "2026-11-02T09:05:00Z"),
      said("a", FOREMAN, "2026-11-02T10:01:00Z"),
    ];
    assert.equal(planReply(thread, FOREMAN).ok, false);
    assert.equal(planReply(thread, FOREMAN, "2026-11-02T10:00:00Z").ok, false);
  });
});
