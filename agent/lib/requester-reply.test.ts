import assert from "node:assert/strict";
import { test } from "node:test";
import type { FollowUpOutcome } from "./follow-up-decisions.js";
import {
  assertThreadComplete,
  createThreadComment,
  directFollowUp,
  judgeFollowUp,
  planReply,
  promptedFollowUp,
  readAllComments,
  relayedFollowUp,
  replyToRequester,
  type ThreadComment,
  ThreadIncompleteError,
} from "./requester-reply.js";

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

test("fails when the issue has no requester thread", () => {
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

test("replies under the conversation whose note is waiting, not the earliest anchor", () => {
  const support = (id: string, createdAt: string): ThreadComment => ({
    body: `Support conversation connected in [Acquisity inbox](https://app/${id})`,
    createdAt,
    id,
    parentId: null,
    userId: "aaron",
  });
  const note = (
    id: string,
    parentId: string,
    userId: string,
    createdAt: string
  ): ThreadComment => ({ body: "note", createdAt, id, parentId, userId });
  const thread = [
    anchor,
    support("a", "2026-09-25T16:00:00Z"),
    support("b", "2026-09-25T16:05:00Z"),
    note("a1", "a", "aaron", "2026-09-25T16:10:00Z"),
    note("a2", "a", FOREMAN, "2026-09-25T16:12:00Z"),
    note("b1", "b", "aaron", "2026-09-25T16:20:00Z"),
  ];
  assert.deepEqual(planReply(thread, FOREMAN), {
    anchorId: "b",
    followUp: null,
    ok: true,
  });
  const laterOnA = [
    ...thread,
    note("a3", "a", "aaron", "2026-09-25T16:30:00Z"),
  ];
  const plan = planReply(laterOnA, FOREMAN);
  assert.equal(plan.ok && plan.anchorId, "a");
  assert.deepEqual(plan.ok && plan.followUp, {
    lastReply: "note",
    replies: ["note"],
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

test("a relayed Slack reply is judged before the model runs", () => {
  const relay = (id: string, parentId: string | null): ThreadComment => ({
    body: "@acquisityforeman1 **Gary** replied in Slack:\n\nthanks!",
    createdAt: "2026-09-26T10:05:00Z",
    id,
    parentId,
    userId: "aaron",
  });
  const foreman = reply("f1", FOREMAN, "2026-09-26T10:04:00Z");
  const thread = [
    anchor,
    foreman,
    relay("under", "anchor"),
    relay("top", null),
  ];
  const plan = planReply(thread, FOREMAN);
  assert.ok(relayedFollowUp(thread, plan, "top"));

  const direct = {
    ...relay("ask", null),
    body: "@acquisityforeman1 look again",
  };
  assert.equal(relayedFollowUp([...thread, direct], plan, "ask"), null);

  const late = {
    ...relay("new", null),
    body: "@acquisityforeman1 **Gary** replied in Slack:\n\nwhat does it cost?",
  };
  assert.equal(
    relayedFollowUp([...thread, late], plan, "new"),
    null,
    "a relay whose copy under the anchor has not landed is not judged"
  );

  const first = [anchor, relay("under", "anchor"), relay("top", null)];
  assert.deepEqual(
    relayedFollowUp(first, planReply(first, FOREMAN), "top"),
    { lastReply: "", replies: [relay("under", "anchor").body] },
    "a relay before Foreman's first reply is judged against the whole thread"
  );
});

test("a prompted reply is judged against what arrived since the previous prompt", () => {
  const said = (id: string, at: string, body: string): ThreadComment => ({
    body: `**Gary** replied in Slack:\n\n${body}`,
    createdAt: at,
    id,
    parentId: "anchor",
    userId: "aaron",
  });
  const prompt = (id: string, at: string): ThreadComment => ({
    body: "**Gary** replied in Slack.",
    createdAt: at,
    id,
    parentId: "session",
    userId: "aaron",
  });
  const thread = [
    anchor,
    { ...reply("f1", FOREMAN, "2026-09-26T10:00:00Z"), body: "Which amount?" },
    said("r1", "2026-09-26T10:01:00Z", "the $40 one?"),
    prompt("p1", "2026-09-26T10:01:01Z"),
    said("r2", "2026-09-26T10:02:00Z", "@teammate can you check?"),
    prompt("p2", "2026-09-26T10:02:01Z"),
  ];
  const plan = planReply(thread, FOREMAN);
  assert.deepEqual(promptedFollowUp(thread, plan, "p2"), {
    earlier: [thread[2].body],
    lastReply: "Which amount?",
    replies: [thread[4].body],
  });
  assert.deepEqual(
    promptedFollowUp(thread, plan, "p1"),
    { lastReply: "Which amount?", replies: [thread[2].body] },
    "the first prompt judges replies up to itself, not the next prompt's"
  );
  assert.equal(
    promptedFollowUp(thread, plan, "r2"),
    null,
    "only the receiver's prompt is judged this way"
  );
});

test("a support inbox note is judged like a Slack reply", () => {
  const inbox: ThreadComment = {
    ...anchor,
    body: "Support conversation connected in [Acquisity inbox](https://app.acquisity.ai/dashboard/admin/support?conversation=c1)",
  };
  const note: ThreadComment = {
    body: "**Dana** added a note in the support inbox:\n\nCan you check their domains?",
    createdAt: "2026-09-26T10:01:00Z",
    id: "n1",
    parentId: "anchor",
    userId: "aaron",
  };
  const prompt: ThreadComment = {
    body: "**Dana** added a note in the support inbox.",
    createdAt: "2026-09-26T10:01:01Z",
    id: "p1",
    parentId: "session",
    userId: "aaron",
  };
  const thread = [inbox, note, prompt];
  const plan = planReply(thread, FOREMAN);
  assert.equal(plan.ok, true);
  assert.deepEqual(relayedFollowUp(thread, plan, "n1"), {
    lastReply: "",
    replies: [note.body],
  });
  assert.deepEqual(promptedFollowUp(thread, plan, "p1"), {
    lastReply: "",
    replies: [note.body],
  });
});

const foremanUser = {
  displayName: "acquisityforeman1",
  id: FOREMAN,
  url: "https://linear.app/acquisity/profiles/acquisityforeman1",
};
const said = (
  id: string,
  userId: string,
  createdAt: string,
  body: string,
  parentId: string | null = "session"
): ThreadComment => ({ body, createdAt, id, parentId, userId });
const sessionThread = [
  said(
    "session",
    "linear",
    "2026-10-02T20:05:00Z",
    "This thread is for an agent session with acquisityforeman1.",
    null
  ),
  said("f1", FOREMAN, "2026-10-02T20:08:00Z", "Comment posted."),
];

test("judges a reply in a widget ticket's session thread against Foreman's last message", () => {
  const thanks = said("p1", "aaron", "2026-10-02T20:09:00Z", "thanks");
  assert.deepEqual(
    directFollowUp([...sessionThread, thanks], foremanUser, {
      commentId: "p1",
      prompted: true,
    }),
    { lastReply: "Comment posted.", replies: ["thanks"] }
  );
});

for (const mention of [`@${foremanUser.displayName}`, foremanUser.url]) {
  for (const prompted of [false, true]) {
    test(`normalizes ${mention} for a ${prompted ? "prompted" : "created"} event and dispatches a bare mention`, () => {
      const thanks = said(
        "m1",
        "aaron",
        "2026-10-02T20:09:00Z",
        `thanks ${mention}`
      );
      const bare = said("m2", "aaron", "2026-10-02T20:10:00Z", mention);
      const comments = [...sessionThread, thanks, bare];
      assert.deepEqual(
        directFollowUp(comments, foremanUser, { commentId: "m1", prompted }),
        { lastReply: "Comment posted.", replies: ["thanks @Foreman"] }
      );
      assert.equal(
        directFollowUp(comments, foremanUser, { commentId: "m2", prompted }),
        null
      );
    });
  }
}

test("leaves delegation alone", () => {
  assert.equal(
    directFollowUp(sessionThread, foremanUser, {
      commentId: "session",
      prompted: false,
    }),
    null
  );
});

test("leaves Foreman's own comments and relayed prompts to the other gates", () => {
  const prompt = said(
    "p2",
    "aaron",
    "2026-10-02T20:09:00Z",
    "**Aaron Fraga** added a note in the support inbox."
  );
  const comments = [...sessionThread, prompt];
  const prompted = (commentId: string) =>
    directFollowUp(comments, foremanUser, { commentId, prompted: true });
  assert.equal(prompted("p2"), null);
  assert.equal(prompted("f1"), null);
  assert.equal(prompted("missing"), null);
});

test("treats a mention with only punctuation around it as bare", () => {
  for (const body of [
    "@acquisityforeman1,",
    "@acquisityforeman1!",
    "@acquisityforeman1 ?",
  ]) {
    const comments = [
      ...sessionThread,
      said("b1", "aaron", "2026-10-02T20:09:00Z", body),
    ];
    for (const prompted of [true, false]) {
      assert.equal(
        directFollowUp(comments, foremanUser, { commentId: "b1", prompted }),
        null,
        body
      );
    }
  }
});

const created = (id: string) =>
  Response.json({
    data: {
      commentCreate: {
        comment: { id, url: `https://example.com/${id}` },
        success: true,
      },
    },
  });

test("createThreadComment writes under the anchor and carries a client id when given one", async () => {
  const bodies: {
    query: string;
    variables: { input: Record<string, string> };
  }[] = [];
  const api = {
    fetch: (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(created("c1"));
    },
  };
  const base = {
    api,
    body: "Hello",
    credentials: { accessToken: "t" },
    issueId: "i1",
    parentId: "a1",
  };
  assert.deepEqual(await createThreadComment(base), {
    id: "c1",
    url: "https://example.com/c1",
  });
  await createThreadComment({
    ...base,
    id: "00000000-0000-4000-8000-000000000001",
  });
  assert.deepEqual(bodies[0]?.variables.input, {
    body: "Hello",
    issueId: "i1",
    parentId: "a1",
  });
  assert.equal(
    bodies[1]?.variables.input.id,
    "00000000-0000-4000-8000-000000000001"
  );
});

test("createThreadComment refuses a write Linear does not confirm", async () => {
  const api = {
    fetch: () =>
      Promise.resolve(
        Response.json({
          data: { commentCreate: { comment: null, success: false } },
        })
      ),
  };
  await assert.rejects(
    createThreadComment({
      api,
      body: "x",
      credentials: { accessToken: "t" },
      issueId: "i",
      parentId: "a",
    }),
    { message: "Linear did not create the reply." }
  );
});

test("assertThreadComplete refuses a thread it cannot read in full", () => {
  assert.doesNotThrow(() => assertThreadComplete("ENG-1", false));
  assert.throws(
    () => assertThreadComplete("ENG-1", true),
    ThreadIncompleteError
  );
});

/** Serves comment pages in order, as Linear does with `after`. */
const pagesOf =
  (pages: readonly ThreadComment[][], more = false) =>
  <T>(_query: string, _name: string, variables: Record<string, unknown>) => {
    const index = Number(variables.after ?? 0);
    const next = more || index + 1 < pages.length;
    return Promise.resolve({
      issue: {
        comments: {
          nodes: (pages[index] ?? []).map((c) => ({
            body: c.body,
            createdAt: c.createdAt,
            id: c.id,
            parent: c.parentId ? { id: c.parentId } : null,
            user: c.userId ? { id: c.userId, name: c.userId } : null,
          })),
          pageInfo: {
            endCursor: next ? String(index + 1) : null,
            hasNextPage: next,
          },
        },
      },
    } as T);
  };

test("reads every page, so a reply past the first page still counts", async () => {
  const first = [
    anchor,
    reply("f1", FOREMAN, "2026-09-25T16:00:00Z"),
    ...Array.from({ length: 98 }, (_, i) => ({
      ...reply(`n${i}`, "aaron", "2026-09-25T16:30:00Z"),
      parentId: null,
    })),
  ];
  const second = [reply("r2", "requester", "2026-09-25T17:00:00Z")];
  const comments = await readAllComments("ENG-1", pagesOf([first, second]));
  assert.equal(comments.length, 101);
  assert.deepEqual(planReply(comments, FOREMAN), {
    anchorId: "anchor",
    followUp: { lastReply: "text", replies: ["text"] },
    ok: true,
  });
});

test("refuses a thread longer than ten pages", async () => {
  let calls = 0;
  const endless = pagesOf([[anchor]], true);
  await assert.rejects(
    readAllComments("ENG-1", (query, name, variables) => {
      calls += 1;
      return endless(query, name, variables);
    }),
    {
      message:
        "ENG-1 has more than 1,000 comments, so the thread state cannot be checked; reply in Slack by hand.",
      name: "ThreadIncompleteError",
    }
  );
  assert.equal(calls, 10);
});

test("acts on a person's direct status request on an ordinary ticket, and on nothing else there", async () => {
  const markDone = said(
    "d1",
    "aaron",
    "2026-10-02T20:09:00Z",
    "@acquisityforeman1 mark this Done"
  );
  const thread = {
    comments: [...sessionThread, markDone],
    foreman: foremanUser,
    plan: planReply([...sessionThread, markDone], FOREMAN),
    widgetFeedback: false,
  };
  const trigger = { commentId: "d1", prompted: true };
  const judged: string[][] = [];
  const answer =
    (outcome: FollowUpOutcome) => (input: { replies: string[] }) => {
      judged.push(input.replies);
      return Promise.resolve(outcome);
    };
  assert.equal(
    await judgeFollowUp(thread, trigger, answer("status")),
    "status"
  );
  assert.deepEqual(judged, [["@Foreman mark this Done"]]);
  assert.deepEqual(
    await Promise.all(
      (["respond", "skip"] as const).map((outcome) =>
        judgeFollowUp(thread, trigger, answer(outcome))
      )
    ),
    [null, null]
  );
  assert.equal(
    await judgeFollowUp(
      { ...thread, widgetFeedback: true },
      trigger,
      answer("skip")
    ),
    "skip"
  );
});

test("refuses an incomplete comment page without a continuation cursor", async () => {
  await assert.rejects(
    readAllComments(
      "ENG-1",
      async <T>() =>
        ({
          issue: {
            comments: {
              nodes: [],
              pageInfo: { endCursor: null, hasNextPage: true },
            },
          },
        }) as T
    ),
    {
      message:
        "ENG-1 has more comments but no continuation cursor, so the thread state cannot be checked.",
    }
  );
});

test("rejects a malformed comment page instead of normalizing missing fields", async () => {
  await assert.rejects(
    readAllComments(
      "ENG-1",
      async <T>() =>
        ({
          issue: {
            comments: {
              nodes: [
                {
                  body: "sample",
                  createdAt: "2026-10-28T00:00:00Z",
                  id: "sample",
                  parent: null,
                },
              ],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        }) as T
    ),
    { name: "ZodError" }
  );
});

test("bounds the requester metadata and comment page requests with signals", async (t) => {
  const signals: (AbortSignal | null | undefined)[] = [];
  t.mock.method(globalThis, "fetch", (_url: unknown, init?: RequestInit) => {
    signals.push(init?.signal);
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    if (query.includes("IssueComments")) {
      throw new Error("stop before write");
    }
    return Promise.resolve(
      Response.json({
        data: {
          issue: { id: "issue", identifier: "ENG-1", project: null },
          viewer: { id: FOREMAN },
        },
      })
    );
  });
  await assert.rejects(
    replyToRequester("ENG-1", "unused", "local-test-token"),
    {
      message: "stop before write",
    }
  );
  assert.equal(signals.length, 2);
  for (const signal of signals) {
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
  }
  assert.notEqual(signals[0], signals[1]);
});
