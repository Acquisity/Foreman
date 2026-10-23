import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { tool as createIssueTool } from "../../tools/create_triage_replay_issue.js";
import routeTicketTool from "../../tools/route_ticket.js";
import { billingRoutes, triageDecisions } from "../triage-log.js";
import { setReplayBackend } from "./backend.js";
import { ctx, inSession, outputOf, replayProcess } from "./fixtures.js";

const BLOB_DOWN = /blob down/u;
const ROUTE = { assignee: "Ada Lovelace", project: "Cold Email Core" };
const toolCtx = {
  ...ctx,
  getToken: () => Promise.reject(new Error("no Linear token in a replay")),
  session: { ...ctx.session, id: "sess-1" },
} as never;

const create = () =>
  outputOf(
    createIssueTool.execute(
      { description: "Refund follow-up.", title: "Refund follow-up" },
      toolCtx
    )
  );

const route = (t: TestContext) => {
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => {
    lines.push(line);
  });
  return async (issue: string) => {
    await outputOf(routeTicketTool.execute({ ...ROUTE, issue }, toolCtx));
    const event = lines
      .map((line) => JSON.parse(line) as { code?: string; issue?: string })
      .filter((parsed) => parsed.issue === issue)
      .at(-1);
    return event?.code;
  };
};

describe("a billing decision made before its ticket exists", () => {
  it("binds to the issue this session creates next, so routing it logs billing", async (t) => {
    await replayProcess(t);
    const routed = route(t);
    await inSession(async () => {
      billingRoutes.update(() => ROUTE);
      const { identifier } = await create();
      assert.deepEqual(triageDecisions.get()[identifier]?.route, ROUTE);
      assert.equal(billingRoutes.get(), null);
      assert.equal(await routed(identifier), "billing");
    });
  });

  it("is dropped when the creation fails, so a later matching route logs a fallback", async (t) => {
    const backend = await replayProcess(t);
    const routed = route(t);
    await inSession(async () => {
      billingRoutes.update(() => ROUTE);
      setReplayBackend({
        ...backend,
        read: () => Promise.reject(new Error("blob down")),
      });
      await assert.rejects(create(), BLOB_DOWN);
      setReplayBackend(backend);
      assert.equal(billingRoutes.get(), null);
      assert.deepEqual(triageDecisions.get(), {});
      assert.equal(await routed("ENG-100"), "skill_fallback");
    });
  });

  it("is dropped when another ticket is routed first, so a later creation binds nothing", async (t) => {
    await replayProcess(t);
    const routed = route(t);
    await inSession(async () => {
      billingRoutes.update(() => ROUTE);
      assert.equal(await routed("ENG-100"), "skill_fallback");
      assert.equal(billingRoutes.get(), null);
      const { identifier } = await create();
      assert.equal(triageDecisions.get()[identifier], undefined);
      assert.equal(await routed(identifier), "skill_fallback");
    });
  });
});
