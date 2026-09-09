import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectConversation } from "./conversation.js";
import { parseLinearCommentPage } from "./linear-followup.js";
import { issueSnapshot, linkedIssue } from "./linear-state.js";

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

test("relation ordering is quiet for flat and grouped lists without losing relation meaning", () => {
  const first = { id: "ENG-2" };
  const second = { id: "ENG-3" };
  const snapshot = (relations: unknown) =>
    issueSnapshot({ ...issue, relations }, []);
  assert.deepEqual(snapshot([first, second]), snapshot([second, first]));
  assert.deepEqual(
    snapshot({ blockedBy: [first, second], relatedTo: [second] }),
    snapshot({ blockedBy: [second, first], relatedTo: [second] })
  );
  assert.notDeepEqual(snapshot([first]), snapshot([second]));
  assert.notDeepEqual(snapshot([first]), snapshot([first, second]));
  assert.notDeepEqual(
    snapshot({ blocks: [first] }),
    snapshot({ blockedBy: [first] })
  );
});

test("nested relation object key order is quiet while changed evidence remains observable", () => {
  const snapshot = (relation: unknown) =>
    issueSnapshot({ ...issue, relations: { blockedBy: [relation] } }, []);
  const first = {
    id: "relation-1",
    issue: { id: "ENG-2", state: { name: "In Progress", type: "started" } },
  };
  const reordered = JSON.parse(
    '{"issue":{"state":{"type":"started","name":"In Progress"},"id":"ENG-2"},"id":"relation-1"}'
  ) as typeof first;
  // The old serializer distinguishes these objects; formatting cannot erase the fixture difference.
  assert.notEqual(JSON.stringify(first), JSON.stringify(reordered));
  assert.deepEqual(snapshot(first), snapshot(reordered));
  assert.notDeepEqual(
    snapshot(first),
    snapshot({ ...reordered, issue: { ...reordered.issue, id: "ENG-3" } })
  );
});

test("a corrected Linear title changes the fingerprint and must be valid text", () => {
  const original = linkedIssue.parse({
    ...issue,
    title: "Account connection bug",
  });
  assert.notDeepEqual(
    issueSnapshot(original, []),
    issueSnapshot({ ...original, title: "Configuration error" }, [])
  );
  assert.throws(() => linkedIssue.parse({ ...issue, title: 123 }));
  assert.ok(linkedIssue.safeParse(issue).success);
});

test("comment pages accept each nonempty cursor alias and refuse incomplete evidence", () => {
  const page = { comments: [comment], hasNextPage: true };
  for (const key of ["nextCursor", "endCursor", "cursor"]) {
    assert.deepEqual(parseLinearCommentPage({ ...page, [key]: "page-2" }), {
      comments: [comment],
      next: "page-2",
    });
  }
  assert.equal(
    parseLinearCommentPage({ ...page, endCursor: "page-2", nextCursor: "" })
      .next,
    "page-2"
  );
  assert.equal(
    parseLinearCommentPage({ ...page, endCursor: null, hasNextPage: false })
      .next,
    undefined
  );
  assert.throws(() => parseLinearCommentPage(page));
  assert.throws(() => parseLinearCommentPage({ ...page, endCursor: " " }));
  assert.throws(() =>
    parseLinearCommentPage({ ...page, endCursor: "page-2" }, "page-2")
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
