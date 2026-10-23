import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executorClient } from "../executor/client.js";
import { executorTransport } from "../executor/transport.js";
import {
  findRelatedIssues,
  routeTicket,
  saveInvestigationDocument,
} from "../linear-api.js";
import {
  ReplayStateConflictError,
  replayStateKey,
  seedReplayStore,
  setReplayBackend,
  updateReplayState,
  withReplayState,
} from "./backend.js";
import {
  ARCHIVE_URL,
  auth,
  CASE_CREATED,
  ctx,
  KEY,
  lists,
  RUN,
  replayProcess,
  state,
  TEST_SECRET,
  triageCase,
} from "./fixtures.js";
import { triageReplayHook } from "./hook.js";
import { readReplayResult } from "./route.js";
import { seedReplayState } from "./store.js";
import { replayDocumentText } from "./views.js";

const NEEDS_SECRET = /needs FOREMAN_DIAGNOSTICS_SECRET/u;
const BLOB_DOWN = /blob down/u;

describe("simulated store", () => {
  it("saves a document, serves the exact version to the critic, and routes in the store", async (t) => {
    await replayProcess(t);
    t.mock.method(executorTransport, "call", () => {
      throw new Error("transport reached");
    });
    const client = executorClient(ctx);
    const first = await saveInvestigationDocument(
      { content: "Review: Pending critic", issue: "ENG-100", lane: "triage" },
      { client }
    );
    assert.equal(first.created, true);
    const reviewed = replayDocumentText(await state(), first.documentId);
    assert.equal(reviewed?.updatedAt, first.updatedAt);
    const adjudicated = await saveInvestigationDocument(
      { content: "Review: Adjudicated", issue: "ENG-100", lane: "triage" },
      { client }
    );
    assert.equal(adjudicated.created, false);
    assert.equal(adjudicated.documentId, first.documentId);
    assert.ok(String(adjudicated.updatedAt) > String(first.updatedAt));
    const routed = await routeTicket(
      {
        issue: "ENG-100",
        priority: 2,
        project: "Cold Email Core",
        state: "Todo",
      },
      { client }
    );
    assert.equal(routed.projectName, "Cold Email Core");
    const s = await state();
    assert.equal(s.issue.state, "Todo");
    const docRead = s.inputs.find((i) => i.source === "linear.Document");
    assert.equal(docRead?.provenance, "generated");
  });

  it("answers related issues only from before the case, with as-of fields or unknown", async (t) => {
    await replayProcess(t);
    const result = await findRelatedIssues(
      { phrases: ["inbox reconnect"], scope: "duplicates", windowed: false },
      { client: executorClient(ctx), now: new Date(CASE_CREATED) }
    );
    const ids = result.issues
      .map((i) => i.identifier)
      .sort((a, b) => a.localeCompare(b));
    assert.deepEqual(ids, ["ENG-90", "ENG-95"]);
    const unknown = result.issues.find((i) => i.identifier === "ENG-95");
    assert.equal(unknown?.state, "unknown");
    assert.equal(unknown?.assignee, null);
    assert.deepEqual(unknown?.labels, []);
    assert.equal(unknown?.parentIdentifier, null);
    assert.equal(
      result.issues.find((i) => i.identifier === "ENG-90")?.assignee,
      "Ada Lovelace"
    );
  });
});

describe("frozen list membership", () => {
  it("answers only entries created before the case, and flags a list holding an entry with no creation time", async (t) => {
    await replayProcess(t);
    await withReplayState(RUN, KEY, (s) => {
      s.lists.labels = [
        { createdAt: "2026-09-01T00:00:00.000Z", id: "l-bug", name: "Bug" },
        { createdAt: CASE_CREATED, id: "l-same", name: "Same moment" },
        { createdAt: "2026-10-09T00:00:00.000Z", id: "l-new", name: "Newer" },
      ];
      s.lists.states = [
        { createdAt: "2026-01-01T00:00:00.000Z", id: "s-todo", name: "Todo" },
        { id: "s-todo-undated", name: "Todo" },
      ];
    });
    const client = executorClient(ctx);
    const labels = await client({
      input: { variables: { teamId: "t" } },
      operation: "linear.TeamLabels",
    });
    assert.deepEqual(
      (
        labels.data as { data: { issueLabels: { nodes: { name: string }[] } } }
      ).data.issueLabels.nodes.map((label) => label.name),
      ["Bug"]
    );
    assert.deepEqual((await state()).listMembershipUnknown, []);
    const states = await client({
      input: { variables: { name: "Todo", teamId: "t" } },
      operation: "linear.WorkflowStates",
    });
    assert.deepEqual(
      (
        states.data as {
          data: { workflowStates: { nodes: { id: string }[] } };
        }
      ).data.workflowStates.nodes.map((entry) => entry.id),
      ["s-todo"]
    );
    assert.deepEqual((await state()).listMembershipUnknown, ["states"]);
  });
});

describe("replay storage", () => {
  it("stamps a result with the cohort hash its replay started with, whatever a poll sends", async (t) => {
    const backend = await replayProcess(t);
    const key = replayStateKey(RUN, KEY);
    const started = "a".repeat(64);
    await updateReplayState(
      key,
      (s) => {
        s.cohortSha256 = started;
      },
      backend
    );
    const read = await readReplayResult({
      caseKey: KEY,
      cohortSha256: "b".repeat(64),
      runId: RUN,
    });
    assert.equal(read?.result.cohortSha256, started);
  });

  it("keys every store by an HMAC of the server secret, never by run or case", () => {
    const prior = process.env.FOREMAN_DIAGNOSTICS_SECRET;
    process.env.FOREMAN_DIAGNOSTICS_SECRET = TEST_SECRET;
    const key = replayStateKey(RUN, KEY);
    process.env.FOREMAN_DIAGNOSTICS_SECRET = "u".repeat(40);
    const other = replayStateKey(RUN, KEY);
    delete process.env.FOREMAN_DIAGNOSTICS_SECRET;
    assert.throws(() => replayStateKey(RUN, KEY), NEEDS_SECRET);
    process.env.FOREMAN_DIAGNOSTICS_SECRET = prior;
    assert.equal(key.includes(RUN), false);
    assert.equal(key.includes("ENG-100"), false);
    assert.notEqual(key, other);
  });

  it("keeps both of two writers' changes when they race from separate processes", async (t) => {
    const backend = await replayProcess(t);
    const key = replayStateKey(RUN, KEY);
    await Promise.all([
      updateReplayState(
        key,
        (s) => {
          s.steps += 1;
          s.inputs.push({
            availableAt: null,
            content: "a",
            provenance: "seeded",
            source: "one",
          });
        },
        backend
      ),
      updateReplayState(
        key,
        (s) => {
          s.evidenceMisses.push("sentry.read");
          s.inputs.push({
            availableAt: null,
            content: "b",
            provenance: "seeded",
            source: "two",
          });
        },
        backend
      ),
    ]);
    const after = await state();
    assert.equal(after.steps, 1);
    assert.deepEqual(after.evidenceMisses, ["sentry.read"]);
    assert.deepEqual(
      after.inputs
        .map((input) => input.source)
        .sort((a, b) => a.localeCompare(b)),
      ["case.ticket", "one", "two"]
    );
  });

  it("refuses to seed a store that already exists, and gives up on a write that keeps losing", async (t) => {
    const backend = await replayProcess(t);
    const key = replayStateKey(RUN, KEY);
    await assert.rejects(
      seedReplayStore(
        key,
        seedReplayState(triageCase, lists, ARCHIVE_URL),
        backend
      ),
      ReplayStateConflictError
    );
    const losing = {
      ...backend,
      write: () => Promise.resolve("conflict" as const),
    };
    await assert.rejects(
      updateReplayState(key, (s) => s.steps, losing),
      ReplayStateConflictError
    );
  });

  it("cancels the turn even when the store can't be written", async (t) => {
    const backend = await replayProcess(t);
    setReplayBackend({
      ...backend,
      write: () => Promise.reject(new Error("blob down")),
    });
    const cancels: string[] = [];
    const hookCtx = {
      cancel: () => cancels.push("cancel"),
      session: { auth: { current: auth, initiator: auth }, id: "sess-1" },
    };
    const handler = (name: keyof typeof triageReplayHook.events) =>
      triageReplayHook.events[name] as (
        e: unknown,
        c: unknown
      ) => Promise<void>;
    await assert.rejects(
      handler("actions.requested")(
        {
          data: {
            actions: [
              {
                callId: "1",
                input: {},
                kind: "tool-call",
                toolName: "push_branch",
              },
            ],
          },
        },
        hookCtx
      ),
      BLOB_DOWN
    );
    await assert.rejects(handler("step.started")({}, hookCtx), BLOB_DOWN);
    await assert.rejects(
      handler("action.result")(
        {
          data: {
            result: {
              callId: "2",
              kind: "tool-result",
              output: "x",
              toolName: "grep",
            },
          },
        },
        hookCtx
      ),
      BLOB_DOWN
    );
    assert.deepEqual(cancels, ["cancel", "cancel", "cancel"]);
  });
});
