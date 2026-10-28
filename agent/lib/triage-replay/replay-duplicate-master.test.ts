import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderClient } from "../executor/operations.js";
import { routeTicket } from "../linear-api.js";
import type { LinearOperation } from "../linear-operations.js";
import { ARCHIVE_URL, KEY, lists, triageCase } from "./fixtures.js";
import { answerLinear } from "./linear-simulation.js";
import { type ReplayState, seedReplayState } from "./store.js";

const LINEAR_PREFIX = /^linear\./u;

/**
 * The lone-report branch of a Bug duplicate, replayed: the run creates a
 * master, parents the existing lone report ENG-91 under it, then routes the
 * case as its duplicate. Live Linear lets both steps land; replay must too.
 */
const seeded = (): ReplayState => {
  const state = seedReplayState(
    {
      ...triageCase,
      relatedSnapshot: [
        ...triageCase.relatedSnapshot,
        {
          assignee: null,
          createdAt: "2026-09-28T00:00:00.000Z",
          description: "Inbox reconnect after every send",
          id: "ENG-91",
          labels: ["Customer reported"],
          parent: null,
          state: "Todo",
          title: "Reconnect after send",
        },
      ],
    },
    {
      archiveUrl: ARCHIVE_URL,
      caseKey: KEY,
      lists,
      stamp: { foremanCommit: "f".repeat(40), startedAt: "2026-10-28" },
    }
  );
  state.created.push({
    description: "Root cause: the token refresh drops the inbox session.",
    fields: {
      assignee: null,
      labels: ["Bug"],
      parent: null,
      priority: 2,
      project: null,
      state: "Todo",
    },
    identifier: "ENG-200",
    title: "Master: inbox reconnect after send",
  });
  return state;
};

const replayClient =
  (state: ReplayState): ProviderClient =>
  (request) => {
    const operation = request.operation.replace(
      LINEAR_PREFIX,
      ""
    ) as LinearOperation;
    const variables =
      "variables" in request.input ? request.input.variables : {};
    return Promise.resolve({
      data: { data: answerLinear(state, operation, variables) },
      status: 200,
    });
  };

describe("replayed duplicate masters (R2, R3)", () => {
  it("parents an existing lone report under a run-created master, then routes the case under that master inside the cutoff", async () => {
    const state = seeded();
    const client = replayClient(state);
    const parented = await routeTicket(
      { issue: "ENG-91", parent: "ENG-200" },
      { client }
    );
    assert.equal(parented.parentIdentifier, "ENG-200");

    const routed = await routeTicket(
      { duplicateOf: "ENG-91", issue: "ENG-100", state: "Duplicate" },
      {
        client,
        masterRequired: true,
        mastersCreatedAfter: "2026-09-01T00:00:00.000Z",
      }
    );
    assert.equal(routed.parentIdentifier, "ENG-200");
    assert.equal(routed.duplicateOf, "ENG-91");
    assert.equal(state.issue.parent, "ENG-200");
  });
});
