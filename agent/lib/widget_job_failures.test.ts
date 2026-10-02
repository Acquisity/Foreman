import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ProviderContext } from "#lib/executor/dispatch.js";
import { WIDGET_TOOLKIT } from "#lib/executor/endpoint.js";
import { executorTransport } from "#lib/executor/transport.js";
import { verifiedFinContext } from "#lib/fin-investigation.fixture.js";
import { finInvestigationAuth } from "#lib/fin-investigation-auth.js";
import { verifiedWidgetContext } from "#lib/widget.fixture.js";
import { widgetAuth } from "#lib/widget-scope.js";
import definition, {
  buildQuery,
  readWidgetJobFailures,
  widgetJobFailuresInput,
} from "../tools/widget_job_failures.js";

const scope = verifiedWidgetContext;
const originalConnector = process.env.EXECUTOR_MCP_CONNECTOR;
const originalBindings = process.env.EXECUTOR_OPERATION_BINDINGS;
process.env.EXECUTOR_MCP_CONNECTOR = "executor.test/widget";
process.env.EXECUTOR_OPERATION_BINDINGS = JSON.stringify({
  "planetscale.readQuery": {
    path: "planetscale.org.foremanPlanetscale.planetscale_execute_read_query",
  },
});
after(() => {
  if (originalBindings === undefined) {
    delete process.env.EXECUTOR_OPERATION_BINDINGS;
  } else {
    process.env.EXECUTOR_OPERATION_BINDINGS = originalBindings;
  }
  if (originalConnector === undefined) {
    delete process.env.EXECUTOR_MCP_CONNECTOR;
  } else {
    process.env.EXECUTOR_MCP_CONNECTOR = originalConnector;
  }
});

const ctx = {
  abortSignal: new AbortController().signal,
  getToken: async () => ({ token: "test-token" }),
  session: { auth: { current: null, initiator: widgetAuth(scope) } },
} as unknown as ProviderContext;

const envelope = (
  failures: unknown[],
  options: { authorized?: boolean; workspace?: unknown } = {}
) => ({
  content: [
    {
      text: JSON.stringify({
        rows: [
          {
            authorized: options.authorized ?? true,
            failures,
            workspace:
              options.workspace === undefined
                ? "Test Workspace"
                : options.workspace,
          },
        ],
        success: true,
      }),
      type: "text",
    },
  ],
});

const failureRow = {
  area: "scrape",
  entity_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  entity_type: "lead_scrape_run",
  error_message: null,
  has_error: false,
  observed_at: "2026-09-17T00:00:00.000Z",
  saved_run_id: "run_123",
  status: "failed",
};

test("tool is exposed only for the widget support initiator", () => {
  const resolve = definition.events["step.started"];
  assert.ok(resolve);
  assert.ok(resolve({} as never, ctx as never));
  for (const initiator of [
    null,
    finInvestigationAuth(verifiedFinContext),
    { attributes: {}, issuer: "slack" },
  ]) {
    assert.equal(
      resolve(
        {} as never,
        {
          session: { auth: { current: widgetAuth(scope), initiator } },
        } as never
      ),
      null
    );
  }
});

test("input is strict: rejects org id, sql, and unknown keys", () => {
  assert.ok(widgetJobFailuresInput.safeParse({}).success);
  assert.ok(widgetJobFailuresInput.safeParse({ area: "ai_sdr" }).success);
  assert.ok(widgetJobFailuresInput.safeParse({ since: "24h" }).success);
  for (const bad of [
    { organizationId: scope.organizationId },
    { query: "select 1" },
    { area: "campaign_dispatch" },
    { area: "billing" },
    { since: "1y" },
  ]) {
    assert.equal(widgetJobFailuresInput.safeParse(bad).success, false);
  }
});

test("every area subquery scopes to the org and re-checks membership", () => {
  const q = buildQuery(scope, {});
  // membership + org gate
  assert.ok(q.includes(`o.id = '${scope.organizationId}'::uuid`));
  assert.ok(q.includes(`m.user_id = '${scope.userId}'::uuid`));
  assert.ok(q.includes("m.role in ('owner','admin')"));
  assert.ok(
    q.includes(
      `(o.partner_id is null or o.partner_id = '${scope.partnerId}'::uuid)`
    )
  );
  // each product join hangs off the authorized org
  for (const j of [
    "join authorized a on a.id = e.organization_id",
    "join authorized a on a.id = o.organization_id",
    "join authorized a on a.id = r.organization_id",
  ]) {
    assert.ok(q.includes(j), j);
  }
  // area filter narrows the union
  assert.ok(
    !buildQuery(scope, { area: "scrape" }).includes("agent_executions")
  );
});

test("dispatch sends the org-scoped query through the widget toolkit", async (t) => {
  const call = t.mock.method(executorTransport, "call", async () => ({
    data: envelope([failureRow]),
    ok: true,
  }));
  const result = await readWidgetJobFailures(ctx, {});
  assert.equal(call.mock.callCount(), 1);
  const [wire, , input] = call.mock.calls[0].arguments as unknown as [
    { toolkit: string },
    string,
    { query: string },
  ];
  assert.equal(wire.toolkit, WIDGET_TOOLKIT);
  assert.ok(input.query.includes(scope.organizationId));
  assert.equal(result.status, "ok");
});

test("output labels stored references without claiming Inngest ownership", async (t) => {
  t.mock.method(executorTransport, "call", async () => ({
    data: envelope([
      failureRow,
      {
        ...failureRow,
        area: "provisioning",
        entity_type: "domain_purchase_order",
        has_error: true,
        saved_run_id: null,
        secretLeak: "should be dropped",
        status: "requires_attention",
      },
    ]),
    ok: true,
  }));
  const result = await readWidgetJobFailures(ctx, {});
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    return;
  }
  assert.equal(result.failures.length, 2);
  assert.deepEqual(result.failures[0].runReference, {
    id: "run_123",
    kind: "scrape_provider_run_or_submission",
  });
  assert.equal(result.failures[1].runReference, null);
  assert.equal("inngestRunId" in result.failures[0], false);
  assert.equal(result.failures[1].status, "requires_attention");
  assert.equal(result.failures[1].hasError, true);
  // no raw error text field leaked
  assert.equal(JSON.stringify(result).includes("should be dropped"), false);
});

test("empty, denied and unavailable stay distinct", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  // empty: authorized, no failures
  t.mock.method(executorTransport, "call", async () => ({
    data: envelope([]),
    ok: true,
  }));
  const empty = await readWidgetJobFailures(ctx, {});
  assert.equal(empty.status, "ok");
  assert.deepEqual(empty.status === "ok" ? empty.failures : null, []);

  // denied: authorization row false
  t.mock.method(executorTransport, "call", async () => ({
    data: envelope([], { authorized: false, workspace: null }),
    ok: true,
  }));
  assert.equal((await readWidgetJobFailures(ctx, {})).status, "denied");

  // unavailable: transport throws
  t.mock.method(executorTransport, "call", () =>
    Promise.reject(new Error("boom"))
  );
  assert.equal((await readWidgetJobFailures(ctx, {})).status, "unavailable");
  assert.ok(warn.mock.callCount() >= 1);
});

test("non-widget session is refused before dispatch", async (t) => {
  const call = t.mock.method(executorTransport, "call", async () => ({
    data: envelope([]),
    ok: true,
  }));
  const finCtx = {
    ...ctx,
    session: {
      auth: {
        current: null,
        initiator: finInvestigationAuth(verifiedFinContext),
      },
    },
  } as unknown as ProviderContext;
  await assert.rejects(() => readWidgetJobFailures(finCtx, {}));
  assert.equal(call.mock.callCount(), 0);
});

test("failure messages are bounded, sanitized and unavailable scrape detail remains null", async (t) => {
  t.mock.method(executorTransport, "call", async () => ({
    data: envelope([
      {
        ...failureRow,
        area: "ai_sdr",
        entity_type: "agent_execution",
        error_details: { secret: "private-details" },
        error_message:
          'Authentication failed password=privatepassword123 at https://provider.test/?signature=private-signature for owner@example.com; {"token":"private-token"}',
        has_error: true,
      },
      failureRow,
    ]),
    ok: true,
  }));
  const result = await readWidgetJobFailures(ctx, { since: "24h" });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    assert.fail("Expected failures");
  }
  assert.equal(result.failures[0].runReference?.kind, "internal_execution_run");
  assert.ok(result.failures[0].error?.startsWith("Authentication failed"));
  assert.equal(result.failures[1].error, null);
  for (const secret of [
    "privatepassword123",
    "private-signature",
    "owner@example.com",
    "private-token",
    "private-details",
  ]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.deepEqual(result.coveredAreas, ["ai_sdr", "provisioning", "scrape"]);
  const query = buildQuery(scope, { area: "ai_sdr", since: "24h" });
  assert.ok(query.includes("interval '1 days'"));
  assert.ok(query.includes("e.error ->> 'message'"));
  assert.equal(query.includes("e.input"), false);
  assert.equal(query.includes("inngest_run_id"), false);
});
