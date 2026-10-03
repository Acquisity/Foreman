import assert from "node:assert/strict";
import { test } from "node:test";
import {
  directFollowUp,
  planReply,
  promptedFollowUp,
  relayedFollowUp,
  type ThreadComment,
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
