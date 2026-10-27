import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CRITIC_CRITERIA } from "../../subagents/critic/agent.js";
import { tool as commentTool } from "../../tools/comment_triage_replay_issue.js";
import { tool as createIssueTool } from "../../tools/create_triage_replay_issue.js";
import { tool as catalogTool } from "../../tools/list_triage_replay_catalog.js";
import { tool as readIssueTool } from "../../tools/read_triage_replay_issue.js";
import replyTool from "../../tools/reply_to_requester.js";
import { executorClient } from "../executor/client.js";
import { executorTransport } from "../executor/transport.js";
import { routeTicket, saveInvestigationDocument } from "../linear-api.js";
import { SUPPORT_OWNER } from "../owner-map.js";
import { routeRefusal, settleCriticRound } from "../triage-log.js";
import { withReplayState } from "./backend.js";
import {
  auth,
  ctx,
  KEY,
  outputOf,
  RUN,
  replayHandler,
  replayProcess,
  state,
} from "./fixtures.js";
import { buildReplayResult, replaySettled } from "./route.js";
import { NEW_MASTER } from "./schema.js";
import { appliedRoute } from "./views.js";

const TOKEN_REFRESH = /token refresh/u;
const SUPPORT_OWNER_RULE = /assignee set to Aaron Fraga/u;
const DEVELOPER_RULE = /is a developer/u;
const ONLY_CASE_DOCUMENTS = /documents only on ENG-100/u;

const rootCtx = {
  session: { auth: { current: auth, initiator: auth }, id: "sess-root" },
} as never;

let call = 0;
const toolResult = (toolName: string, output: unknown, isError = false) => {
  call += 1;
  return replayHandler("action.result")(
    {
      data: {
        result: {
          callId: `call-${call}`,
          isError,
          kind: "tool-result",
          output,
          toolName,
        },
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

const noTransport = (t: Parameters<typeof replayProcess>[0]) =>
  t.mock.method(executorTransport, "call", () => {
    throw new Error("transport reached");
  });

const endTurn = () => replayHandler("turn.completed")({ data: {} }, rootCtx);

const criticReply = (verdict: string, over: Record<string, unknown> = {}) => ({
  advisory_notes: [],
  blocking_findings: verdict === "APPROVE" ? [] : [{ claim: "c" }],
  criteria_results: CRITIC_CRITERIA.map((criterion) => ({
    criterion,
    evidence: "read",
    rationale: "checked",
    result: verdict === "APPROVE" ? "PASS" : "FAIL",
  })),
  reviewed: {
    commit: "c".repeat(40),
    document_id: "doc-1",
    document_updated_at: "2026-10-27T10:00:00.000Z",
    issue_id: "ENG-100",
  },
  summary: "s",
  verdict,
  ...over,
});
const objection = criticReply("CHALLENGE");
const skillLoadFailure = criticReply("INSUFFICIENT_EVIDENCE", {
  blocking_findings: [],
  criteria_results: [],
  reviewed: {
    commit: "unpinned",
    document_id: "doc-1",
    document_updated_at: "2026-10-27T10:00:00.000Z",
    issue_id: "ENG-100",
  },
});
const PACKET_MESSAGE = [
  "Source issue: ENG-100",
  "Document: doc-1",
  "Document updatedAt: 2026-10-27T10:00:00.000Z",
  `Commit: ${"c".repeat(40)}`,
].join("\n");
const criticDispatched = (callId: string, message = PACKET_MESSAGE) =>
  replayHandler("actions.requested")(
    {
      data: {
        actions: [
          {
            callId,
            input: { message },
            kind: "subagent-call",
            subagentName: "critic",
          },
        ],
      },
    },
    rootCtx
  );
const criticSettles = async (callId: string, output: unknown) => {
  await criticDispatched(callId);
  await criticSettled(callId, output);
};
const criticSettled = (callId: string, output: unknown) =>
  replayHandler("task.settled")(
    {
      data: {
        callId,
        kind: "agent",
        name: "critic",
        output,
        status: "completed",
      },
    },
    rootCtx
  );

describe("replay result", () => {
  it("settles only when the root turn ends, and fails a route that never applied", async (t) => {
    await replayProcess(t);
    await toolResult(
      "decide_triage",
      routeDecision({ needsCriticReview: true, path: "Engineering Todo" })
    );
    assert.equal(replaySettled(await state()), false);
    await replayHandler("turn.completed")(
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
    await endTurn();
    const ended = await state();
    assert.equal(replaySettled(ended), true);
    assert.equal(buildReplayResult(ended, RUN).status, "failed");
  });

  it("builds the final from what the store applied to the case", async (t) => {
    await replayProcess(t);
    noTransport(t);
    await toolResult("decide_triage", routeDecision());
    await toolResult("decide_triage", { error: "late" }, true);
    await routeTicket(
      {
        addLabels: ["Bug"],
        duplicateOf: "ENG-90",
        inheritAssigneeFrom: "ENG-90",
        issue: "ENG-100",
        project: "Cold Email Core",
        state: "Duplicate",
      },
      { client: executorClient(ctx) }
    );
    await endTurn();
    const result = buildReplayResult(await state(), RUN);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.final, {
      assignee: "Anthony Adewale",
      classification: "Bug",
      duplicateOf: "ENG-90",
      master: "ENG-90",
      outcome: "route",
      path: "Duplicate",
      project: "Cold Email Core",
    });
  });

  it("does not complete a routed duplicate until the critic has a result", async (t) => {
    await replayProcess(t);
    noTransport(t);
    await toolResult(
      "decide_triage",
      routeDecision({
        needsCriticReview: true,
        review: { kind: "duplicate", reason: "r", required: true },
      })
    );
    await routeTicket(
      {
        addLabels: ["Bug"],
        duplicateOf: "ENG-90",
        inheritAssigneeFrom: "ENG-90",
        issue: "ENG-100",
        project: "Cold Email Core",
        state: "Duplicate",
      },
      { client: executorClient(ctx) }
    );
    await endTurn();
    assert.equal(buildReplayResult(await state(), RUN).status, "failed");
    await replayHandler("task.settled")(
      {
        data: {
          callId: "critic-1",
          kind: "agent",
          name: "critic",
          output: {
            blocking_findings: [],
            criteria_results: [],
            verdict: "APPROVE",
          },
          status: "completed",
        },
      },
      rootCtx
    );
    assert.equal(buildReplayResult(await state(), RUN).status, "completed");
  });

  it("scores a ticket the critic objected to twice as unproven with its owner assigned, not as routed", async (t) => {
    await replayProcess(t);
    noTransport(t);
    const client = executorClient(ctx);
    await toolResult(
      "decide_triage",
      routeDecision({
        needsCriticReview: true,
        review: { kind: "duplicate", reason: "r", required: true },
      })
    );
    await criticSettles("critic-1", objection);
    await criticSettles("critic-2", objection);
    await saveInvestigationDocument(
      { content: "Blocked.", issue: "ENG-100", lane: "triage" },
      { client }
    );
    const blocked = settleCriticRound(
      settleCriticRound({}, "ENG-100", "objection"),
      "ENG-100",
      "objection"
    );
    const guardedRoute = (input: { assignee: string; issue: string }) => {
      const refusal = routeRefusal({}, blocked, input);
      return refusal
        ? Promise.reject(new Error(refusal))
        : routeTicket(input, { client });
    };
    await assert.rejects(
      guardedRoute({ assignee: "Anthony Adewale", issue: "ENG-100" }),
      SUPPORT_OWNER_RULE
    );
    await assert.rejects(
      routeTicket(
        { assignee: "Anthony Adewale", issue: "ENG-100" },
        { client }
      ),
      DEVELOPER_RULE
    );
    await guardedRoute({ assignee: SUPPORT_OWNER, issue: "ENG-100" });
    await endTurn();
    const result = buildReplayResult(await state(), RUN);
    assert.equal(result.status, "completed");
    assert.equal(result.final?.outcome, "unproven");
    assert.equal(result.final?.path, null);
    assert.deepEqual((await state()).issue.labels, []);
    assert.equal(result.final?.assignee, SUPPORT_OWNER);
    assert.equal(result.final?.master, null);
  });

  it("does not count two reviews that could not start as objections", async (t) => {
    await replayProcess(t);
    noTransport(t);
    await toolResult(
      "decide_triage",
      routeDecision({
        needsCriticReview: true,
        review: { kind: "duplicate", reason: "r", required: true },
      })
    );
    await criticSettles("critic-1", skillLoadFailure);
    await criticSettles("critic-2", skillLoadFailure);
    const settled = await state();
    assert.equal(settled.criticObjections ?? 0, 0);
    assert.equal(settled.critic?.counted, "failed");
    assert.equal(settled.critic?.verdict, "INSUFFICIENT_EVIDENCE");
  });

  it("counts a republished critic settlement once", async (t) => {
    await replayProcess(t);
    noTransport(t);
    await criticSettles("critic-1", objection);
    await criticSettles("critic-1", objection);
    assert.equal((await state()).criticObjections, 1);
    await criticSettles("critic-2", objection);
    assert.equal((await state()).criticObjections, 2);
  });

  it("does not count an objection to a packet the critic was not sent", async (t) => {
    await replayProcess(t);
    noTransport(t);
    await criticDispatched(
      "critic-1",
      PACKET_MESSAGE.replace("doc-1", "doc-2")
    );
    await criticSettled("critic-1", objection);
    await criticDispatched("critic-2", "Source issue: ENG-100\nPlease review.");
    await criticSettled("critic-2", objection);
    const settled = await state();
    assert.equal(settled.criticObjections ?? 0, 0);
    assert.equal(settled.critic?.counted, "failed");
  });

  it("ignores a critic result dispatched for an earlier decision", async (t) => {
    await replayProcess(t);
    noTransport(t);
    const closure = routeDecision({
      needsCriticReview: true,
      review: { kind: "duplicate", reason: "r", required: true },
    });
    await toolResult("decide_triage", closure);
    await criticDispatched("critic-a");
    await toolResult("decide_triage", closure);
    await criticSettled("critic-a", objection);
    const stale = await state();
    assert.equal(stale.critic, null);
    assert.equal(stale.criticObjections ?? 0, 0);
    await criticSettles("critic-b", objection);
    assert.equal((await state()).criticObjections, 1);
  });

  it("keeps a review when a decide_triage retry failed while it ran", async (t) => {
    await replayProcess(t);
    noTransport(t);
    await toolResult(
      "decide_triage",
      routeDecision({
        needsCriticReview: true,
        review: { kind: "duplicate", reason: "r", required: true },
      })
    );
    await criticDispatched("critic-1");
    await toolResult("decide_triage", { decided: false, error: "Jev failed." });
    await criticSettled("critic-1", objection);
    const settled = await state();
    assert.equal(settled.critic?.counted, "objection");
    assert.equal(settled.criticObjections, 1);
  });

  it("waits for the critic when the decision needs review", async (t) => {
    await replayProcess(t);
    noTransport(t);
    await toolResult(
      "decide_triage",
      routeDecision({ needsCriticReview: true })
    );
    await routeTicket(
      { issue: "ENG-100", project: "Cold Email Core" },
      { client: executorClient(ctx) }
    );
    await endTurn();
    assert.equal(buildReplayResult(await state(), RUN).status, "failed");
    await replayHandler("task.settled")(
      {
        data: {
          kind: "agent",
          name: "critic",
          output: "{}",
          status: "completed",
        },
      },
      rootCtx
    );
    const result = buildReplayResult(await state(), RUN);
    assert.equal(result.critic?.verdict, "failed");
    assert.equal(result.status, "completed");
  });

  it("scores a billing decision once its route is applied", async (t) => {
    await replayProcess(t);
    noTransport(t);
    await toolResult("decide_billing", {
      decided: true,
      decision: {
        discretion: "needs-human",
        notes: [],
        route: { assignee: "Aaron Fraga", project: "Support" },
        unconfirmed: [],
      },
    });
    await routeTicket(
      { issue: "ENG-100", priority: 3, state: "Todo" },
      { client: executorClient(ctx) }
    );
    await endTurn();
    const result = buildReplayResult(await state(), RUN);
    assert.equal(result.status, "completed");
    assert.equal(result.final?.path, "Support/Financial");
    assert.equal(result.final?.classification, null);
  });

  it("completes an unproven stop once its document is saved", async (t) => {
    await replayProcess(t);
    await toolResult("decide_triage", {
      decided: true,
      decision: { missing: [], notes: [], outcome: "unproven" },
    });
    await saveInvestigationDocument(
      {
        content: "## Root cause\nUnproven.\n## Ruled out\nThe token.",
        issue: "ENG-100",
        lane: "triage",
      },
      { client: executorClient(ctx) }
    );
    await endTurn();
    const result = buildReplayResult(await state(), RUN);
    assert.equal(result.status, "completed");
    assert.equal(result.final?.outcome, "unproven");
    assert.equal(result.diagnosis, "Unproven.");
  });
});

describe("replay Executor client", () => {
  it("answers Linear from the store and refuses every other operation", async (t) => {
    await replayProcess(t);
    noTransport(t);
    const client = executorClient(ctx);
    const refused = await client({
      input: { query: "select 1" },
      operation: "planetscale.readQuery",
    } as never);
    assert.equal(refused.status, 503);
    assert.deepEqual((await state()).evidenceMisses, ["planetscale.readQuery"]);
    const routed = await routeTicket(
      { addLabels: ["Bug"], assignee: "Anthony Adewale", issue: "ENG-100" },
      { client }
    );
    assert.equal(routed.assignee, "Anthony Adewale");
  });
});

describe("replay documents", () => {
  it("keeps documents on the case's ticket and refuses one for another issue", async (t) => {
    await replayProcess(t);
    noTransport(t);
    await assert.rejects(
      saveInvestigationDocument(
        { content: "Other.", issue: "ENG-90", lane: "triage" },
        { client: executorClient(ctx) }
      ),
      ONLY_CASE_DOCUMENTS
    );
    assert.deepEqual((await state()).documents, []);
  });
});

describe("replay Linear tools", () => {
  const toolCtx = {
    ...ctx,
    getToken: () => Promise.reject(new Error("no Linear token in a replay")),
  } as never;

  it("lists the projects open and the Root Cause labels that existed when the case was filed", async (t) => {
    await replayProcess(t);
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
    assert.deepEqual(await catalogTool.execute({}, toolCtx), {
      projects: [{ name: "Billing" }, { name: "Cold Email Core" }],
      rootCauseLabels: ["Instantly API"],
    });
  });

  it("keeps the requester reply and comments in the replay", async (t) => {
    await replayProcess(t);
    const reply = await replyTool.execute(
      { issue: "ENG-100", message: "Your inbox reconnects after a send." },
      toolCtx
    );
    assert.equal((reply as { posted: boolean }).posted, true);
    await commentTool.execute(
      { body: "Root cause: the token refresh.", issue: "ENG-100" },
      toolCtx
    );
    const read = await outputOf(
      readIssueTool.execute({ issue: "ENG-100" }, toolCtx)
    );
    assert.equal(read.found, true);
    assert.match(JSON.stringify(read), TOKEN_REFRESH);
    const related = await readIssueTool.execute({ issue: "ENG-90" }, toolCtx);
    assert.equal((related as { issue: { state: string } }).issue.state, "Todo");
    assert.equal(
      (await outputOf(readIssueTool.execute({ issue: "ENG-130" }, toolCtx)))
        .found,
      false
    );
    assert.equal(
      (await outputOf(readIssueTool.execute({ issue: "ENG-404" }, toolCtx)))
        .found,
      false
    );
  });

  it("scores a new master the replay created as the new-master answer", async (t) => {
    await replayProcess(t);
    noTransport(t);
    const { identifier } = await outputOf(
      createIssueTool.execute(
        {
          assignee: "anthony@example.test",
          description: "Token refresh races the send.",
          title: "Inbox token refresh race",
        },
        toolCtx
      )
    );
    await routeTicket(
      {
        addLabels: ["Bug"],
        inheritAssigneeFrom: identifier,
        issue: "ENG-100",
        parent: identifier,
      },
      { client: executorClient(ctx) }
    );
    const s = await state();
    assert.equal(s.issue.assignee, "Anthony Adewale");
    assert.equal(appliedRoute(s).master, NEW_MASTER);
  });
});
