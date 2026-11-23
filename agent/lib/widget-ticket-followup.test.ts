import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXY_LINEAR_USER_ID } from "./fixy-handoff.js";
import {
  commentIdFor,
  followUpOnTicket,
  type linearAppRequest,
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

test("a follow-up on an open ticket adds one comment with a fixed id and the customer's words, and moves nothing", async () => {
  const { request, sent } = linear({
    WidgetFollowUp: { commentCreate: { success: true } },
  });
  await followUpOnTicket(
    { identifier: "ENG-7", stateType: "started" },
    "Still broken.\nSecond line.",
    RUN,
    signal,
    request
  );
  assert.deepEqual(sent, [
    {
      name: "WidgetFollowUp",
      variables: {
        input: {
          body: "The customer followed up in the support chat:\n\n> Still broken.\n> Second line.",
          id: commentIdFor(`widget-follow-up:${RUN}`),
          issueId: "ENG-7",
        },
      },
    },
  ]);
});

test("a follow-up on a Done ticket comments and moves it back to Todo", async () => {
  const { request, sent } = linear({
    WidgetFollowUp: { commentCreate: { success: true } },
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
    ["WidgetFollowUp", "WidgetTicketStates", "WidgetTicketReopen"]
  );
  assert.deepEqual(sent[2].variables, { id: "ENG-7", stateId: "todo" });
});

test("a follow-up that Linear refuses throws, so the customer is never told it was passed on", async () => {
  const refused = linear({
    WidgetFollowUp: { commentCreate: { success: false } },
  });
  await assert.rejects(
    followUpOnTicket(
      { identifier: "ENG-7", stateType: "completed" },
      "x",
      RUN,
      signal,
      refused.request
    )
  );
  assert.equal(refused.sent.length, 1);
  const stuck = linear({
    WidgetFollowUp: { commentCreate: { success: true } },
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
});

const comment = (
  body: string,
  user: string | null,
  updatedAt: string,
  parent: { id: string } | null = null
) => ({ body, parent, updatedAt, user: user ? { id: user } : null });

test("the ticket note gives the status and Fixy's newest top-level comment with links, ticket numbers and ids taken out", async () => {
  const { request } = linear({
    WidgetTicketComments: {
      issue: {
        comments: {
          nodes: [
            comment(
              "Old closing note.",
              FIXY_LINEAR_USER_ID,
              "2026-11-01T00:00:00Z"
            ),
            comment(
              "Fixed the sync for workspace 11111111-1111-4111-8111-111111111111 in ENG-9 https://github.com/x/y/pull/1 so sending resumes.",
              FIXY_LINEAR_USER_ID,
              "2026-11-03T00:00:00Z"
            ),
            comment(
              "A reply in a thread.",
              FIXY_LINEAR_USER_ID,
              "2026-11-04T00:00:00Z",
              { id: "p" }
            ),
            comment(
              "A teammate's note.",
              "someone-else",
              "2026-11-05T00:00:00Z"
            ),
          ],
        },
        state: { type: "completed" },
      },
    },
  });
  const note = await ticketNote("ENG-7", signal, request);
  assert.ok(note?.includes("it is done."));
  assert.ok(note?.includes("Fixed the sync for workspace"));
  assert.ok(note?.includes("so sending resumes."));
  for (const hidden of [
    "ENG-9",
    "github.com",
    "11111111-",
    "Old closing",
    "teammate",
    "thread",
  ]) {
    assert.ok(!note?.includes(hidden), hidden);
  }
});

test("a ticket with no closing comment yet says the team's answer will come here", async () => {
  const { request } = linear({
    WidgetTicketComments: {
      issue: { comments: { nodes: [] }, state: { type: "triage" } },
    },
  });
  const note = await ticketNote("ENG-7", signal, request);
  assert.ok(note?.includes("with the team, not started yet"));
  assert.ok(note?.includes("their answer will come here in this chat"));
  assert.equal(
    await ticketNote(
      "ENG-7",
      signal,
      linear({ WidgetTicketComments: { issue: null } }).request
    ),
    null
  );
});
