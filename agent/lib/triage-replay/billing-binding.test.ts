import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { tool as createIssueTool } from "../../tools/create_triage_replay_issue.js";
import decideBillingTool from "../../tools/decide_billing.js";
import routeTicketTool from "../../tools/route_ticket.js";
import { billingQuestions } from "../jev-decisions.js";
import { withReplayState } from "./backend.js";
import { ctx, inSession, outputOf, replayProcess } from "./fixtures.js";

const toolCtx = {
  ...ctx,
  getToken: () => Promise.reject(new Error("no Linear token in a replay")),
  session: { ...ctx.session, id: "sess-1" },
} as never;

const LISTED = "2026-01-01T00:00:00.000Z";
const ROUTE = {
  assignee: "Aaron Fraga",
  priority: 3,
  project: "Support",
  state: "Todo",
};

async function liveIntercomSession(t: TestContext) {
  await replayProcess(t);
  await withReplayState("run-test-1", "ENG-100#1", (state) => {
    state.lists.projects.push({
      createdAt: LISTED,
      id: "p-support",
      name: "Support",
    });
    state.lists.users.push({
      createdAt: LISTED,
      id: "u-aaron",
      name: "Aaron Fraga",
    });
  });
  process.env.AI_GATEWAY_API_KEY = "test-key";
  t.mock.method(globalThis, "fetch", () => {
    const answers = Object.fromEntries(
      Object.entries(billingQuestions()).map(([key, question]) => [
        key,
        question.type === "choice"
          ? {
              choice: "justified",
              probabilities: { justified: 0.9 },
              type: "choice",
            }
          : { probability: 0.9, type: "boolean" },
      ])
    );
    return Promise.resolve(
      Response.json({ answers, model: "typesafe-ai/jev" })
    );
  });
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => {
    lines.push(line);
  });
  const decide = async () => {
    const decided = await outputOf(
      decideBillingTool.execute(
        {
          approvalQuote: null,
          bucket: "refund",
          evidence: "The charge matches the invoice.",
          sourceLabels: [],
        },
        toolCtx
      )
    );
    assert.equal(decided.decided, true);
    return (decided as { decisionId: string }).decisionId;
  };
  const createTicket = async () =>
    (
      await outputOf(
        createIssueTool.execute(
          { description: "Refund proposal.", title: "Refund proposal" },
          toolCtx
        )
      )
    ).identifier;
  const route = async (issue: string, billingDecision?: string) => {
    const routed = await outputOf(
      routeTicketTool.execute({ ...ROUTE, billingDecision, issue }, toolCtx)
    );
    assert.equal(routed.routed, true);
    return lines
      .map(
        (line) =>
          JSON.parse(line) as { code?: string; issue?: string; path?: string }
      )
      .filter((event) => event.issue === issue)
      .at(-1);
  };
  return { createTicket, decide, route };
}

describe("the live Intercom billing order", () => {
  it("logs the billing path against the ticket created after the decision", async (t) => {
    const { createTicket, decide, route } = await liveIntercomSession(t);
    await inSession(async () => {
      const decisionId = await decide();
      const issue = await createTicket();
      const event = await route(issue, decisionId);
      assert.equal(event?.issue, issue);
      assert.equal(event?.code, "billing");
      assert.equal(event?.path, "Support/Financial");
    });
  });

  it("logs a fallback for a matching route that doesn't carry the decision's id, and still binds the right ticket after it", async (t) => {
    const { createTicket, decide, route } = await liveIntercomSession(t);
    await inSession(async () => {
      const decisionId = await decide();
      const unrelated = await route("ENG-100");
      assert.equal(unrelated?.code, "skill_fallback");
      assert.equal(unrelated?.path, null);
      const issue = await createTicket();
      assert.equal(
        (await route(issue, "someone-elses-id"))?.code,
        "skill_fallback"
      );
      const event = await route(issue, decisionId);
      assert.equal(event?.code, "billing");
      assert.equal(event?.path, "Support/Financial");
    });
  });

  it("binds the decision once, so a second ticket with the same id logs a fallback", async (t) => {
    const { createTicket, decide, route } = await liveIntercomSession(t);
    await inSession(async () => {
      const decisionId = await decide();
      const first = await createTicket();
      assert.equal((await route(first, decisionId))?.code, "billing");
      const second = await createTicket();
      assert.equal((await route(second, decisionId))?.code, "skill_fallback");
    });
  });
});
