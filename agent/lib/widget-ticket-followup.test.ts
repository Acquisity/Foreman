import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXY_RUN_FINISHED } from "./fixy-handoff.js";
import {
  commentIdFor,
  followUpOnTicket,
  type linearAppRequest,
  ownsConversation,
  ticketNote,
} from "./widget-ticket-followup.js";

const { signal } = new AbortController();
const RUN = "44444444-4444-4444-8444-444444444444";

/** Answers each named Linear request in turn and records what was sent. */
const linear = (answers: Record<string, unknown>) => {
  const sent: { name: string; variables: unknown }[] = [];
  const request = ((name: string, _query: string, variables: unknown) => {
    sent.push({ name, variables });
    return Promise.resolve(answers[name]);
  }) as typeof linearAppRequest;
  return { request, sent };
};

const states = {
  issue: {
    team: {
      states: {
        nodes: [
          { id: "backlog", name: "Backlog", position: 0 },
          { id: "todo", name: "Todo", position: 1 },
        ],
      },
    },
  },
};
const commented = { WidgetTicketComment: { commentCreate: { success: true } } };

test("a follow-up on an open ticket adds one comment with a fixed id and the summary, and moves nothing", async () => {
  const { request, sent } = linear(commented);
  await followUpOnTicket(
    { identifier: "ENG-7", stateType: "started" },
    "Still broken.\nSecond line.",
    RUN,
    signal,
    request
  );
  assert.deepEqual(sent, [
    {
      name: "WidgetTicketComment",
      variables: {
        input: {
          body: "Foreman passed this conversation to the team again from the support chat:\n\n> Still broken.\n> Second line.",
          id: commentIdFor(`widget-follow-up:${RUN}`),
          issueId: "ENG-7",
        },
      },
    },
  ]);
});

test("a follow-up on a Done ticket moves it back to Todo before it comments", async () => {
  const { request, sent } = linear({
    ...commented,
    WidgetTicketReopen: { issueUpdate: { success: true } },
    WidgetTicketStates: states,
  });
  await followUpOnTicket(
    { identifier: "ENG-7", stateType: "completed" },
    "It broke again.",
    RUN,
    signal,
    request
  );
  assert.deepEqual(
    sent.map(({ name }) => name),
    ["WidgetTicketStates", "WidgetTicketReopen", "WidgetTicketComment"]
  );
  assert.deepEqual(sent[1].variables, { id: "ENG-7", stateId: "todo" });
});

test("a reopen that fails writes no comment, and a retry after a failed comment only comments", async () => {
  const stuck = linear({
    ...commented,
    WidgetTicketReopen: { issueUpdate: { success: false } },
    WidgetTicketStates: states,
  });
  await assert.rejects(
    followUpOnTicket(
      { identifier: "ENG-7", stateType: "completed" },
      "x",
      RUN,
      signal,
      stuck.request
    )
  );
  assert.ok(!stuck.sent.some(({ name }) => name === "WidgetTicketComment"));
  // The reopen landed and the comment failed: the search now sees the ticket open.
  const refused = linear({
    WidgetTicketComment: { commentCreate: { success: false } },
  });
  await assert.rejects(
    followUpOnTicket(
      { identifier: "ENG-7", stateType: "unstarted" },
      "x",
      RUN,
      signal,
      refused.request
    )
  );
  const retried = linear(commented);
  await followUpOnTicket(
    { identifier: "ENG-7", stateType: "unstarted" },
    "x",
    RUN,
    signal,
    retried.request
  );
  assert.deepEqual(
    retried.sent.map(({ name }) => name),
    ["WidgetTicketComment"]
  );
});

const SCOPE = {
  conversationId: "33333333-3333-4333-8333-333333333333",
  organizationId: "22222222-2222-4222-8222-222222222222",
};
const scopeBlock = `## Verified scope\n\n- Workspace: Acme (acme)\n- Organization ID: ${SCOPE.organizationId}\n- Support conversation: ${SCOPE.conversationId}\n\nServer note.`;

test("only a ticket whose description carries this conversation's scope block belongs to it", async () => {
  const owns = (description: string | null) =>
    ownsConversation(
      "ENG-7",
      SCOPE,
      signal,
      linear({ WidgetTicketDescription: { issue: { description } } }).request
    );
  assert.equal(await owns(`The customer wrote: x\n\n${scopeBlock}`), true);
  assert.equal(
    await owns(
      `A master that quotes conversation ${SCOPE.conversationId} in its notes.`
    ),
    false
  );
  assert.equal(
    await owns(
      scopeBlock.replace(
        SCOPE.organizationId,
        "99999999-9999-4999-8999-999999999999"
      )
    ),
    false
  );
  assert.equal(await owns(null), false);
});

const fixyComments = (
  type: string,
  nodes: { body: string; parent: { id: string } | null }[]
) =>
  linear({
    WidgetTicketComments: { issue: { comments: { nodes }, state: { type } } },
  }).request;

test("the investigator's note has Fixy's newest top-level reply with links, ticket numbers and ids taken out; the writers get the status alone", async () => {
  // Newest first, as Linear returns them for orderBy: updatedAt.
  const note = await ticketNote(
    "ENG-7",
    signal,
    fixyComments("completed", [
      { body: FIXY_RUN_FINISHED, parent: null },
      { body: "A reply in a thread.", parent: { id: "p" } },
      {
        body: "Fixed the sync for workspace 11111111-1111-4111-8111-111111111111 in ENG-9 https://github.com/x/y/pull/1 so sending resumes, UTF-8 intact.",
        parent: null,
      },
      { body: "Old closing note.", parent: null },
    ])
  );
  const investigator = note?.forInvestigator ?? "";
  assert.ok(investigator.includes("it is done."));
  assert.ok(investigator.includes("Fixed the sync for workspace"));
  assert.ok(investigator.includes("so sending resumes, UTF-8 intact."));
  for (const hidden of [
    "ENG-9",
    "github.com",
    "11111111-",
    "Old closing",
    "thread",
    FIXY_RUN_FINISHED,
  ]) {
    assert.ok(!investigator.includes(hidden), hidden);
  }
  assert.equal(
    note?.forWriters,
    "This conversation already has a ticket with the support team, and it is done. Never mention the ticket itself, its status names, links, code or people."
  );
});

test("a ticket with no closing reply yet says the team's answer will come here, and an unreadable one gives no note", async () => {
  const note = await ticketNote(
    "ENG-7",
    signal,
    fixyComments("triage", [{ body: FIXY_RUN_FINISHED, parent: null }])
  );
  for (const text of [note?.forWriters, note?.forInvestigator]) {
    assert.ok(text?.includes("with the team, not started yet"));
    assert.ok(text?.includes("it will come here in this chat"));
  }
  assert.equal(
    await ticketNote(
      "ENG-7",
      signal,
      linear({ WidgetTicketComments: { issue: null } }).request
    ),
    null
  );
});
