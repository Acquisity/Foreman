import assert from "node:assert/strict";
import { test } from "node:test";
import type { FollowUpOutcome } from "./follow-up-decisions.js";
import {
  relayedFollowUpOutcome,
  type ThreadComment,
} from "./requester-reply.js";

const FOREMAN = "foreman";
const STATE_FIELDS = /state \{ type name \}/u;
const foremanUser = {
  displayName: "acquisityforeman1",
  id: FOREMAN,
  url: "https://linear.app/acquisity/profiles/acquisityforeman1",
};
const anchor: ThreadComment = {
  body: "Slack thread connected in [#acquisity-comms-feedback](https://x.slack.com/archives/C1/p1)",
  createdAt: "2026-11-18T09:00:00Z",
  id: "anchor",
  parentId: null,
  userId: "aaron",
};
const answered: ThreadComment = {
  body: "Ronald's campaign has been sending since 17 Nov.",
  createdAt: "2026-11-19T02:29:38Z",
  id: "f1",
  parentId: "anchor",
  userId: FOREMAN,
};
// The receiver's prompt into Foreman's open session for the same reply.
const prompt: ThreadComment = {
  body: "**Michelle** replied in Slack.",
  createdAt: "2026-11-20T08:49:57Z",
  id: "p1",
  parentId: "session",
  userId: "aaron",
};
const relay: ThreadComment = {
  body: "**Michelle** replied in Slack:\n\nAny update? Is this fixed for everyone?",
  createdAt: "2026-11-20T08:49:56Z",
  id: "r1",
  parentId: "anchor",
  userId: "aaron",
};

// ENG-19424: a relayed question on a fixy ticket, read through the real thread query. Each ticket id is in its own state.
const STATES: Record<string, { name: string; type: string }> = {
  "ENG-1": { name: "In Progress", type: "started" },
  "ENG-2": { name: "Duplicate", type: "canceled" },
  "ENG-3": { name: "Done", type: "completed" },
  "ENG-4": { name: "Canceled", type: "canceled" },
  "ENG-5": { name: "To Code Review", type: "started" },
};
const linear = (t: { mock: { method: typeof test.mock.method } }) =>
  t.mock.method(globalThis, "fetch", (_url: unknown, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables: { id: string };
    };
    if (query.includes("IssueComments")) {
      return Promise.resolve(
        Response.json({
          data: {
            issue: {
              comments: {
                nodes: [anchor, answered, relay, prompt].map((comment) => ({
                  ...comment,
                  parent: comment.parentId ? { id: comment.parentId } : null,
                  updatedAt: comment.createdAt,
                  user: { id: comment.userId, name: "Tester" },
                })),
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          },
        })
      );
    }
    assert.match(query, STATE_FIELDS);
    return Promise.resolve(
      Response.json({
        data: {
          issue: {
            id: variables.id,
            identifier: variables.id,
            labels: { nodes: [{ name: "fixy" }] },
            project: null,
            state: STATES[variables.id],
          },
          viewer: foremanUser,
        },
      })
    );
  });

const judge = (issue: string, judged: FollowUpOutcome, prompted = false) => {
  let calls = 0;
  return relayedFollowUpOutcome(
    issue,
    { commentId: prompted ? "p1" : "r1", prompted },
    { accessToken: "test-token" },
    undefined,
    () => {
      calls += 1;
      return Promise.resolve(judged);
    }
  ).then((result) => ({ calls, result }));
};

test("ENG-19978: a Slack reply goes to Fixy while Fixy works the ticket, without asking Jev", async (t) => {
  linear(t);
  assert.deepEqual(
    await Promise.all(["ENG-1", "ENG-2"].map((id) => judge(id, "respond"))),
    [
      { calls: 0, result: "fixy" },
      { calls: 0, result: "fixy" },
    ]
  );
});

test("ENG-19978: once Fixy is done or in code review, Foreman answers, and a nudge or status ask is answered afresh", async (t) => {
  linear(t);
  const closed = ["ENG-3", "ENG-4", "ENG-5"];
  const judged: FollowUpOutcome[] = ["respond", "restate", "status"];
  const answers = await Promise.all(
    closed.flatMap((id) =>
      judged.flatMap((j) => [judge(id, j), judge(id, j, true)])
    )
  );
  assert.deepEqual(
    answers.map((a) => a.result),
    closed.flatMap(() => judged.flatMap(() => ["respond", "respond"])),
    "Foreman's earlier reply predates Fixy's closing comment, and Fixy owns the state"
  );
});
