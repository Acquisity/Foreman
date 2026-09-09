import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectConversation } from "./conversation.js";
import { issueSnapshot } from "./linear-state.js";

const issue = {
  assignee: "Engineer A",
  description: "Investigating account connection",
  id: "ENG-1",
  labels: ["bug"],
  status: "In Progress",
  updatedAt: "yesterday",
};
const comment = {
  body: "Need the customer's error timestamp",
  id: "comment-1",
  updatedAt: "today",
};

test("Linear housekeeping alone does not create a follow-up change", () => {
  assert.deepEqual(
    issueSnapshot(issue, [comment]),
    issueSnapshot(
      {
        ...issue,
        assignee: "Engineer B",
        labels: ["bug", "triaged"],
        updatedAt: "today",
      },
      [{ ...comment, updatedAt: "later" }]
    )
  );
});

test("status, customer questions, corrections and fix evidence are observable", () => {
  const baseline = issueSnapshot(issue, [comment]).fingerprint;
  for (const changed of [
    { ...issue, status: "Done" },
    { ...issue, status: "Reopened" },
    { ...issue, description: "Fix needs verification" },
    {
      ...issue,
      attachments: [{ url: "https://github.com/Acquisity/Acquisity/pull/1" }],
    },
  ]) {
    assert.notEqual(issueSnapshot(changed, [comment]).fingerprint, baseline);
  }
  assert.notEqual(
    issueSnapshot(issue, [
      { ...comment, body: "Timestamp is no longer needed" },
    ]).fingerprint,
    baseline
  );
  assert.notEqual(
    issueSnapshot(issue, [
      comment,
      { body: "Ready for support verification", id: "comment-2" },
    ]).fingerprint,
    baseline
  );
});

test("provider comment ordering does not produce repeated updates", () => {
  const second = { body: "More evidence", id: "comment-2" };
  assert.deepEqual(
    issueSnapshot(issue, [comment, second]),
    issueSnapshot(issue, [second, comment])
  );
});

test("snoozed conversations remain eligible for linked Linear follow-up", () => {
  const conversation = {
    conversation_parts: { conversation_parts: [], total_count: 0 },
    created_at: 1,
    id: "123",
    source: { author: { type: "user" }, body: "Waiting for engineering" },
    state: "snoozed",
    updated_at: 2,
  };
  assert.equal(inspectConversation(conversation, "123").closed, false);
  assert.equal(inspectConversation(conversation, "123").snoozed, true);
  assert.equal(
    inspectConversation({ ...conversation, state: "closed" }, "123").closed,
    true
  );
});
