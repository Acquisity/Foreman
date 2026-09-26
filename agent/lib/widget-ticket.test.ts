import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWidgetTicket,
  invokeProvider,
  REFUND_TICKET,
  WIDGET_TICKET_OWNER,
  widgetScopeBlock,
} from "./executor/dispatch.js";
import { executorTransport } from "./executor/transport.js";
import { verifiedWidgetContext } from "./widget.fixture.js";
import { assertWidgetPath, WIDGET_TICKET_PATH } from "./widget-policy.js";
import { widgetAuth } from "./widget-scope.js";

const initiator = widgetAuth(verifiedWidgetContext);
const ctx = () =>
  ({
    abortSignal: AbortSignal.timeout(1000),
    getToken: async () => ({ token: "test-token" }),
    session: { auth: { current: initiator, initiator } },
  }) as never;

const withTransport = async (run: () => Promise<unknown>) => {
  const original = executorTransport.call;
  const connector = process.env.EXECUTOR_MCP_CONNECTOR;
  process.env.EXECUTOR_MCP_CONNECTOR = "executor.test/widget";
  const calls: unknown[][] = [];
  executorTransport.call = ((...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve({ data: {}, ok: true });
  }) as typeof executorTransport.call;
  try {
    await run();
  } finally {
    executorTransport.call = original;
    if (connector === undefined) {
      delete process.env.EXECUTOR_MCP_CONNECTOR;
    } else {
      process.env.EXECUTOR_MCP_CONNECTOR = connector;
    }
  }
  return calls;
};

test("the widget ticket is Aaron's, delegated to Foreman, with team, state and scope from the session", async () => {
  const [call] = await withTransport(() =>
    createWidgetTicket(ctx(), { report: "Report", title: "Inbox fails" })
  );
  assert.equal(call?.[1], WIDGET_TICKET_PATH);
  assert.deepEqual(call?.[2], {
    assignee: "Aaron Fraga",
    delegate: WIDGET_TICKET_OWNER.delegate,
    description: `Report\n\n${widgetScopeBlock(verifiedWidgetContext)}`,
    state: "Triage",
    team: "Engineering Team",
    title: "Inbox fails",
  });
});

test("a refund ticket goes to the billing queue, and only in that exact shape", async () => {
  const scope = widgetScopeBlock(verifiedWidgetContext);
  const [call] = await withTransport(() =>
    createWidgetTicket(ctx(), {
      refund: true,
      report: "Report",
      title: "Refund request",
    })
  );
  assert.deepEqual(call?.[2], {
    assignee: "Aaron Fraga",
    delegate: WIDGET_TICKET_OWNER.delegate,
    description: `Report\n\n${scope}`,
    labels: [...REFUND_TICKET.labels],
    project: REFUND_TICKET.project,
    state: "Triage",
    team: "Engineering Team",
    title: "Refund request",
  });
  const refused = (error: { code?: string }) =>
    error.code === "customer_scope_required";
  const calls = await withTransport(async () => {
    // Half the refund shape, or another label, is not the billing queue.
    await assert.rejects(
      invokeProvider(ctx(), WIDGET_TICKET_PATH, {
        ...WIDGET_TICKET_OWNER,
        description: `x\n\n${scope}`,
        labels: [...REFUND_TICKET.labels],
        state: "Triage",
        team: "Engineering Team",
        title: "Unsafe",
      }),
      refused
    );
    await assert.rejects(
      invokeProvider(ctx(), WIDGET_TICKET_PATH, {
        ...REFUND_TICKET,
        ...WIDGET_TICKET_OWNER,
        description: `x\n\n${scope}`,
        labels: ["Bug"],
        state: "Triage",
        team: "Engineering Team",
        title: "Unsafe",
      }),
      refused
    );
  });
  assert.equal(calls.length, 0);
});

test("a widget session cannot shape the ticket write itself", async () => {
  const scope = widgetScopeBlock(verifiedWidgetContext);
  const refused = (error: { code?: string; dispatched?: unknown }) =>
    error.code === "customer_scope_required" && error.dispatched === false;
  const calls = await withTransport(async () => {
    // No server-written scope block.
    await assert.rejects(
      invokeProvider(ctx(), WIDGET_TICKET_PATH, {
        ...WIDGET_TICKET_OWNER,
        description: "No scope",
        state: "Triage",
        team: "Engineering Team",
        title: "Unsafe",
      }),
      refused
    );
    // Right scope block, but a field the lane does not own.
    await assert.rejects(
      invokeProvider(ctx(), WIDGET_TICKET_PATH, {
        ...WIDGET_TICKET_OWNER,
        assignee: "Someone",
        description: `x\n\n${scope}`,
        state: "Triage",
        team: "Engineering Team",
        title: "Unsafe",
      }),
      refused
    );
    // Another delegate, or none, is not the widget lane's ticket.
    await assert.rejects(
      invokeProvider(ctx(), WIDGET_TICKET_PATH, {
        assignee: WIDGET_TICKET_OWNER.assignee,
        description: `x\n\n${scope}`,
        state: "Triage",
        team: "Engineering Team",
        title: "Unsafe",
      }),
      refused
    );
  });
  assert.equal(calls.length, 0);
  // The generic provider tool checks the read catalog, which never lists the write.
  assert.throws(() => assertWidgetPath(WIDGET_TICKET_PATH));
});
