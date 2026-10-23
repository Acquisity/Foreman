import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tool as commentTool } from "../../tools/comment_triage_replay_issue.js";
import { tool as createIssueTool } from "../../tools/create_triage_replay_issue.js";
import { tool as catalogTool } from "../../tools/list_triage_replay_catalog.js";
import { tool as readIssueTool } from "../../tools/read_triage_replay_issue.js";
import recordCaseTool from "../../tools/record_investigation_case.js";
import replyTool from "../../tools/reply_to_requester.js";
import { executorClient } from "../executor/client.js";
import { executorTransport } from "../executor/transport.js";
import { routeTicket, saveInvestigationDocument } from "../linear-api.js";
import { withReplayState } from "./backend.js";
import {
  auth,
  CASE_CREATED,
  ctx,
  KEY,
  RUN,
  replayProcess,
  state,
} from "./fixtures.js";
import { triageReplayHook } from "./hook.js";
import { buildReplayResult, replaySettled } from "./route.js";
import { NEW_MASTER } from "./schema.js";
import { appliedRoute } from "./store.js";
import { replayMayCall } from "./tool-policy.js";

describe("replay result", () => {
  const META = { cohortSha256: "0".repeat(64), run: 1, runId: RUN };
  const rootCtx = {
    cancel: () => undefined,
    session: { auth: { current: auth, initiator: auth }, id: "sess-root" },
  } as never;
  const handler = (name: keyof typeof triageReplayHook.events) =>
    triageReplayHook.events[name] as (e: unknown, c: unknown) => Promise<void>;
  let call = 0;
  const callTool = async (
    toolName: string,
    input: Record<string, unknown>,
    output: unknown,
    isError = false
  ) => {
    call += 1;
    const callId = `call-${call}`;
    await handler("actions.requested")(
      { data: { actions: [{ callId, input, kind: "tool-call", toolName }] } },
      rootCtx
    );
    await handler("action.result")(
      {
        data: {
          result: { callId, isError, kind: "tool-result", output, toolName },
        },
      },
      rootCtx
    );
  };
  const routeDecision = (overrides: Record<string, unknown> = {}) => ({
    decided: true,
    decision: {
      assignee: "area owner",
      classification: "Bug",
      needsCriticReview: false,
      notes: [],
      outcome: "route",
      path: "Duplicate",
      route: {},
      verdict: { confidence: 0.9, value: "Bug" },
      ...overrides,
    },
  });

  it("does not settle on a provisional decision, only once the root turn ends", async (t) => {
    await replayProcess(t);
    await callTool(
      "decide_triage",
      { identifier: "ENG-100" },
      routeDecision({ needsCriticReview: true, path: "Engineering Todo" })
    );
    const early = await state();
    assert.equal(replaySettled(early), false);
    await handler("turn.completed")({ data: {} }, rootCtx);
    const ended = await state();
    assert.equal(replaySettled(ended), true);
    assert.equal(buildReplayResult(ended, META).status, "failed");
  });

  it("ignores a child session's turn end", async (t) => {
    await replayProcess(t);
    await handler("turn.completed")(
      { data: {} },
      {
        session: {
          auth: { current: auth, initiator: auth },
          id: "sess-critic",
          parent: { sessionId: "sess-root" },
        },
      }
    );
    assert.equal(replaySettled(await state()), false);
  });

  it("builds the final from what the store applied to this case, not from route requests", async (t) => {
    await replayProcess(t);
    t.mock.method(executorTransport, "call", () => {
      throw new Error("transport reached");
    });
    const client = executorClient(ctx);
    await callTool("decide_triage", { identifier: "ENG-100" }, routeDecision());
    await callTool(
      "route_ticket",
      { issue: "ENG-90", project: "Support" },
      { error: "No project.", routed: false }
    );
    await routeTicket(
      {
        duplicateOf: "ENG-90",
        inheritAssigneeFrom: "ENG-90",
        issue: "ENG-100",
        project: "Cold Email Core",
        state: "Duplicate",
      },
      { client }
    );
    await callTool(
      "route_ticket",
      {
        duplicateOf: "ENG-90",
        inheritAssigneeFrom: "ENG-90",
        issue: "ENG-100",
      },
      { routed: true }
    );
    await handler("turn.completed")({ data: {} }, rootCtx);
    const result = buildReplayResult(await state(), META);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.final, {
      assignee: "Ada Lovelace",
      classification: "Bug",
      duplicateOf: "ENG-90",
      master: "ENG-90",
      outcome: "route",
      path: "Duplicate",
      project: "Cold Email Core",
    });
  });

  it("keeps a decision for another issue out of the case's final", async (t) => {
    await replayProcess(t);
    await callTool("decide_triage", { identifier: "ENG-90" }, routeDecision());
    await handler("turn.completed")({ data: {} }, rootCtx);
    const result = buildReplayResult(await state(), META);
    assert.equal(result.final, null);
    assert.equal(result.status, "failed");
  });

  it("scores a billing decision once its route is applied", async (t) => {
    await replayProcess(t);
    t.mock.method(executorTransport, "call", () => {
      throw new Error("transport reached");
    });
    await callTool(
      "decide_billing",
      { bucket: "refund" },
      {
        decided: true,
        decision: {
          discretion: "needs-human",
          notes: [],
          route: {
            addLabels: [],
            assignee: "Aaron Fraga",
            priority: 3,
            project: "Support",
            state: "Todo",
          },
          unconfirmed: [],
        },
      }
    );
    await routeTicket(
      { issue: "ENG-100", priority: 3, state: "Todo" },
      { client: executorClient(ctx) }
    );
    await callTool("route_ticket", { issue: "ENG-100" }, { routed: true });
    await handler("turn.completed")({ data: {} }, rootCtx);
    const result = buildReplayResult(await state(), META);
    assert.equal(result.status, "completed");
    assert.equal(result.final?.path, "Support/Financial");
    assert.equal(result.final?.outcome, "route");
    assert.equal(result.final?.classification, null);
  });

  it("completes an unproven stop once its document is saved, with nothing routed", async (t) => {
    await replayProcess(t);
    await callTool(
      "decide_triage",
      { identifier: "ENG-100" },
      {
        decided: true,
        decision: {
          missing: ["the job run"],
          notes: [],
          outcome: "unproven",
          verdict: { confidence: 0.4, value: "unproven" },
        },
      }
    );
    await saveInvestigationDocument(
      { content: "Unproven.", issue: "ENG-100", lane: "triage" },
      { client: executorClient(ctx) }
    );
    await handler("turn.completed")({ data: {} }, rootCtx);
    const result = buildReplayResult(await state(), META);
    assert.equal(result.status, "completed");
    assert.equal(result.final?.outcome, "unproven");
    assert.equal(result.final?.project, null);
  });
});

describe("replay completion and Linear tools", () => {
  const toolCtx = {
    ...ctx,
    getToken: () => Promise.reject(new Error("no Linear token in a replay")),
  } as never;

  it("lists the projects open and the Root Cause labels that existed when the case was filed", async (t) => {
    await replayProcess(t);
    t.mock.method(executorTransport, "call", () => {
      throw new Error("transport reached");
    });
    const before = "2026-01-01T00:00:00.000Z";
    const after = "2026-10-05T00:00:00.000Z";
    await withReplayState(RUN, KEY, (s) => {
      s.lists.projects = [
        { createdAt: before, id: "p-1", name: "Cold Email Core" },
        {
          completedAt: "2026-02-01T00:00:00.000Z",
          createdAt: before,
          id: "p-2",
          name: "AI SDR v1",
        },
        { completedAt: after, createdAt: before, id: "p-3", name: "Billing" },
        { createdAt: after, id: "p-4", name: "Website" },
      ];
      s.lists.labels = [
        {
          createdAt: before,
          group: "Root Cause",
          id: "l-1",
          name: "Instantly API",
        },
        {
          createdAt: after,
          group: "Root Cause",
          id: "l-2",
          name: "Billing Sync",
        },
        { createdAt: before, id: "l-3", name: "Bug" },
      ];
    });
    assert.equal(replayMayCall("list_triage_replay_catalog"), true);
    const catalog = await catalogTool.execute({}, toolCtx);
    assert.deepEqual(catalog, {
      projects: [{ name: "Billing" }, { name: "Cold Email Core" }],
      rootCauseLabels: ["Instantly API"],
    });
    const recorded = (await state()).inputs.find(
      (input) => input.source === "list_triage_replay_catalog"
    );
    assert.equal(recorded?.provenance, "seeded");
    assert.equal(recorded?.availableAt, CASE_CREATED);
  });

  it("keeps the requester reply and the memory record in the store", async (t) => {
    await replayProcess(t);
    const reply = await replyTool.execute(
      { issue: "ENG-100", message: "Your inbox reconnects after a send." },
      toolCtx
    );
    assert.equal((reply as { posted: boolean }).posted, true);
    assert.equal(
      (recordCaseTool.approval as (c: unknown) => unknown)(toolCtx),
      "not-applicable"
    );
    const recorded = await recordCaseTool.execute(
      {
        claim: "Reconnect after send.",
        classification: "bug",
        sourceIssueId: "ENG-100",
      } as never,
      toolCtx
    );
    assert.equal(recorded.recorded, true);
    const s = await state();
    assert.deepEqual(s.replies, [
      { issue: "ENG-100", message: "Your inbox reconnects after a send." },
    ]);
    assert.equal(s.memory.length, 1);
    assert.equal(replayMayCall("reply_to_requester"), true);
    assert.equal(replayMayCall("record_investigation_case"), true);
  });

  it("reads the full ticket from the store, keeping the replay's own writes generated", async (t) => {
    await replayProcess(t);
    await commentTool.execute(
      { body: "Root cause: the token refresh.", issue: "ENG-100" },
      toolCtx
    );
    const read = await readIssueTool.execute({ issue: "ENG-100" }, toolCtx);
    assert.equal(read.found, true);
    const inputs = (await state()).inputs.filter(
      (input) => input.source === "read_triage_replay_issue"
    );
    assert.deepEqual(
      inputs.map((input) => input.provenance),
      ["seeded", "generated"]
    );
    assert.ok(inputs[0]?.content.includes("Inbox reconnect after send"));
    assert.ok(inputs[1]?.content.includes("token refresh"));
    const related = await readIssueTool.execute({ issue: "ENG-90" }, toolCtx);
    assert.equal((related as { issue: { state: string } }).issue.state, "Todo");
    assert.equal(
      (await readIssueTool.execute({ issue: "ENG-404" }, toolCtx)).found,
      false
    );
  });

  it("scores a new master the replay created as the new-master answer", async (t) => {
    await replayProcess(t);
    t.mock.method(executorTransport, "call", () => {
      throw new Error("transport reached");
    });
    const { identifier } = await createIssueTool.execute(
      {
        assignee: "ada@example.test",
        description: "Token refresh races the send.",
        title: "Inbox token refresh race",
      },
      toolCtx
    );
    await routeTicket(
      { inheritAssigneeFrom: identifier, issue: "ENG-100", parent: identifier },
      { client: executorClient(ctx) }
    );
    const s = await state();
    assert.equal(s.issue.parent, identifier);
    assert.equal(s.issue.assignee, "Ada Lovelace");
    assert.equal(
      buildReplayResult(s, { cohortSha256: "0".repeat(64), run: 1, runId: RUN })
        .final,
      null
    );
    assert.equal(appliedRoute(s).master, NEW_MASTER);
  });

  it("resolves an assignee by email, name or display name, as Linear does", async (t) => {
    await replayProcess(t);
    t.mock.method(executorTransport, "call", () => {
      throw new Error("transport reached");
    });
    for (const assignee of ["ada@example.test", "ADA", "ada lovelace"]) {
      // biome-ignore lint/performance/noAwaitInLoops: each spelling routes on its own.
      const routed = await routeTicket(
        { assignee, issue: "ENG-100" },
        { client: executorClient(ctx) }
      );
      assert.equal(routed.assignee, "Ada Lovelace");
    }
  });
});
