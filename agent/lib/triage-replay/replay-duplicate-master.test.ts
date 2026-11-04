import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tool as readIssueTool } from "../../tools/read_triage_replay_issue.js";
import { routeTicket } from "../route-ticket.js";
import { memoryBackend, seedReplayStore, setReplayBackend } from "./backend.js";
import {
  ARCHIVE_URL,
  ctx,
  KEY,
  lists,
  outputOf,
  RUN,
  replayClient,
  TEST_SECRET,
  triageCase,
} from "./fixtures.js";
import { answerLinear } from "./linear-simulation.js";
import { issueIdOf, type ReplayState, seedReplayState } from "./store.js";

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
    description:
      "## Root cause\n\nThe token refresh drops the inbox session.\n\n## Regression seam\n\nReconnect after a send.",
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

describe("replayed duplicate masters (R2, R3)", () => {
  it("parents an existing lone report under a run-created master, then routes the case under that master inside the cutoff", async (t) => {
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
        mastersCreatedAfter: "2026-09-01T00:00:00.000Z",
      }
    );
    assert.equal(routed.parentIdentifier, "ENG-200");
    assert.equal(routed.duplicateOf, "ENG-91");
    assert.equal(state.issue.parent, "ENG-200");

    const prior = { ...process.env };
    t.after(() => {
      process.env = prior;
    });
    process.env.TRIAGE_REPLAY = "1";
    process.env.FOREMAN_DIAGNOSTICS_SECRET = TEST_SECRET;
    setReplayBackend(memoryBackend());
    await seedReplayStore(state, RUN);
    const read = await outputOf(
      readIssueTool.execute({ issue: "ENG-91" }, {
        ...ctx,
        getToken: () =>
          Promise.reject(new Error("no Linear token in a replay")),
      } as never)
    );
    assert.equal(read.found, true);
    assert.equal(
      (read as { issue: { parent: string | null } }).issue.parent,
      "ENG-200"
    );
  });
});

describe("replayed hand-made masters (Devin 10)", () => {
  const childrenOf = (state: ReplayState, identifier: string) =>
    (
      answerLinear(state, "RelatedIssues", {
        after: null,
        filter: { parent: { id: { eq: issueIdOf(identifier) } } },
        first: 1,
        includeArchived: true,
      }) as { issues: { nodes: { identifier: string }[] } }
    ).issues.nodes.map((node) => node.identifier);

  it("counts the case ticket and run-created issues as children, with the parents the run set", async () => {
    const state = seeded();
    state.created.push({
      description: "A follow-up the run filed.",
      fields: {
        assignee: null,
        labels: ["Bug"],
        parent: "ENG-91",
        priority: 3,
        project: null,
        state: "Todo",
      },
      identifier: "ENG-201",
      title: "Follow-up",
    });
    assert.deepEqual(childrenOf(state, "ENG-91"), ["ENG-201"]);

    const client = replayClient(state);
    await routeTicket({ issue: "ENG-100", parent: "ENG-90" }, { client });
    assert.deepEqual(childrenOf(state, "ENG-90"), ["ENG-100"]);
  });
});

describe("replayed closed masters (C3)", () => {
  for (const closed of ["Done", "Duplicate"]) {
    it(`does not close a duplicate under a master the replay knows is ${closed}`, async () => {
      const state = seedReplayState(triageCase, {
        archiveUrl: ARCHIVE_URL,
        caseKey: KEY,
        lists: {
          ...lists,
          labels: [
            ...lists.labels,
            {
              createdAt: "2026-01-01T00:00:00.000Z",
              id: "l-grouping",
              name: "Needs grouping",
            },
          ],
          states: [
            ...lists.states,
            {
              createdAt: "2026-01-01T00:00:00.000Z",
              id: "s-backlog",
              name: "Backlog",
            },
          ],
        },
        stamp: { foremanCommit: "f".repeat(40), startedAt: "2026-10-28" },
      });
      state.created.push({
        description:
          "## Root cause\n\nThe token refresh drops the inbox session.\n\n## Regression seam\n\nReconnect after a send.",
        fields: {
          assignee: null,
          labels: ["Bug"],
          parent: null,
          priority: 2,
          project: null,
          state: closed,
        },
        identifier: "ENG-201",
        title: "Master: shipped inbox reconnect fix",
      });
      const routed = await routeTicket(
        { duplicateOf: "ENG-201", issue: "ENG-100", state: "Duplicate" },
        { client: replayClient(state) }
      );
      assert.equal(routed.grouping, "needs-grouping");
      assert.equal(routed.duplicateOf, null);
      assert.equal(state.issue.state, "Backlog");
    });
  }
});

describe("replayed masters in an unknown state", () => {
  it("does not close a duplicate under a master whose state the replay cannot type", async () => {
    const state = seedReplayState(triageCase, {
      archiveUrl: ARCHIVE_URL,
      caseKey: KEY,
      lists: {
        ...lists,
        labels: [
          ...lists.labels,
          {
            createdAt: "2026-01-01T00:00:00.000Z",
            id: "l-grouping",
            name: "Needs grouping",
          },
        ],
        states: [
          ...lists.states,
          {
            createdAt: "2026-01-01T00:00:00.000Z",
            id: "s-backlog",
            name: "Backlog",
          },
        ],
      },
      stamp: { foremanCommit: "f".repeat(40), startedAt: "2026-10-28" },
    });
    state.created.push({
      description:
        "## Root cause\n\nThe token refresh drops the inbox session.\n\n## Regression seam\n\nReconnect after a send.",
      fields: {
        assignee: null,
        labels: ["Bug"],
        parent: null,
        priority: 2,
        project: null,
        state: "Shipped to customers",
      },
      identifier: "ENG-202",
      title: "Master: in a custom state",
    });
    const routed = await routeTicket(
      { duplicateOf: "ENG-202", issue: "ENG-100", state: "Duplicate" },
      { client: replayClient(state) }
    );
    assert.equal(routed.grouping, "needs-grouping");
    assert.equal(state.issue.state, "Backlog");
  });
});
