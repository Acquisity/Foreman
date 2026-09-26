import assert from "node:assert/strict";
import { test } from "node:test";
import { planReply, type ThreadComment } from "./requester-reply.js";

const FOREMAN = "foreman";
const anchor: ThreadComment = {
  body: "Slack thread connected in [#acquisity-comms-feedback](https://x.slack.com/archives/C1/p1)",
  createdAt: "2026-09-25T15:15:16Z",
  id: "anchor",
  parentId: null,
  userId: "aaron",
};
const reply = (
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

test("replies under the anchor when Foreman has not spoken yet", () => {
  assert.deepEqual(planReply([anchor], FOREMAN), {
    anchorId: "anchor",
    followUp: null,
    ok: true,
  });
});

test("refuses a second reply until the requester answers", () => {
  const spoke = [anchor, reply("r1", FOREMAN, "2026-09-25T15:34:00Z")];
  assert.equal(planReply(spoke, FOREMAN).ok, false);
  const answered = [...spoke, reply("r2", "aaron", "2026-09-25T15:40:00Z")];
  assert.equal(planReply(answered, FOREMAN).ok, true);
});

test("ignores comments outside the anchor thread", () => {
  const session = {
    ...reply("s1", FOREMAN, "2026-09-25T15:37:00Z"),
    parentId: "session",
  };
  assert.equal(planReply([anchor, session], FOREMAN).ok, true);
});

test("fails when the issue has no Slack thread", () => {
  assert.equal(
    planReply([{ ...anchor, body: "a normal comment" }], FOREMAN).ok,
    false
  );
});

test("uses the earliest top-level anchor, not a later or nested lookalike", () => {
  const nested = {
    ...anchor,
    createdAt: "2026-09-25T15:00:00Z",
    id: "nested",
    parentId: "other",
  };
  const later = { ...anchor, createdAt: "2026-09-25T16:00:00Z", id: "later" };
  assert.deepEqual(planReply([later, nested, anchor], FOREMAN), {
    anchorId: "anchor",
    followUp: null,
    ok: true,
  });
});

test("a reply after Foreman spoke is a follow-up carrying everything said since", () => {
  // ENG-14323: three requester replies after one Foreman answer, each waking
  // a new turn. Every turn sees all of them until Foreman posts again.
  const thread = [
    anchor,
    { ...reply("q", "gary", "2026-09-26T09:50:00Z"), body: "refund please" },
    { ...reply("f1", FOREMAN, "2026-09-26T10:04:00Z"), body: "scope ask" },
    { ...reply("r1", "gary", "2026-09-26T10:05:00Z"), body: "<@U0950315SDC>" },
    {
      ...reply("r2", "gary", "2026-09-26T10:06:00Z"),
      body: "This is a refund save.",
    },
  ];
  assert.deepEqual(planReply(thread, FOREMAN), {
    anchorId: "anchor",
    followUp: {
      lastReply: "scope ask",
      replies: ["<@U0950315SDC>", "This is a refund save."],
    },
    ok: true,
  });
});
