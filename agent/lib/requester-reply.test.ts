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
