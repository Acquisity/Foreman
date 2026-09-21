import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ProviderContext } from "#lib/executor/dispatch.js";
import { executorTransport } from "#lib/executor/transport.js";
import { verifiedFinContext } from "#lib/fin-investigation.fixture.js";
import { finInvestigationAuth } from "#lib/fin-investigation-auth.js";
import { member, WORKSPACE_ID } from "#lib/instantly-fixtures.js";
import { verifiedWidgetContext } from "#lib/widget.fixture.js";
import { widgetAuth } from "#lib/widget-scope.js";
import definition, {
  buildWidgetInboxHealthQuery,
  readWidgetInboxHealth,
  widgetInboxHealthInput,
  widgetInboxHealthOutput,
} from "../tools/widget_inbox_health.js";

const scope = verifiedWidgetContext;
const DB_PATH =
  "planetscale.org.foremanPlanetscale.planetscale_execute_read_query";
const MEMBERS_PATH =
  "foreman_instantly_api.org.foremanInstantlyApi.workspaceGroupMembers.listWorkspaceGroupMembers";
const ACCOUNTS_PATH =
  "foreman_instantly_api.org.foremanInstantlyApi.accounts.listAccounts";

const originalConnector = process.env.EXECUTOR_MCP_CONNECTOR;
const originalBindings = process.env.EXECUTOR_OPERATION_BINDINGS;
process.env.EXECUTOR_MCP_CONNECTOR = "executor.test/widget";
process.env.EXECUTOR_OPERATION_BINDINGS = JSON.stringify({
  "instantly.accounts": { path: ACCOUNTS_PATH },
  "instantly.workspace-group-members": { path: MEMBERS_PATH },
  "planetscale.readQuery": { path: DB_PATH },
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

const NO_CONNECTION = /No Instantly connection/;
const USER_MANAGED = /user-managed/;
const TURNED_OFF = /turned off/;
const observedAt = "2026-09-17T10:00:00.000Z";
const baseRow = (overrides: Record<string, unknown> = {}) => ({
  accountType: null,
  authorized: true,
  connectionUpdatedAt: null,
  hasConnectionError: null,
  initialWarmupEmails: [],
  isActive: null,
  lastWebhookEventAt: null,
  observedAt,
  recentWebhookErrorCount: 0,
  recentWebhookEventCount: 0,
  webhookRegisteredCount: 0,
  workspaceId: null,
  ...overrides,
});
const dbEnvelope = (row: Record<string, unknown>) => ({
  content: [
    { text: JSON.stringify({ rows: [row], success: true }), type: "text" },
  ],
});
const ctx = {
  abortSignal: new AbortController().signal,
  getToken: async () => ({ token: "test-token" }),
  session: { auth: { current: null, initiator: widgetAuth(scope) } },
} as unknown as ProviderContext;

/** Routes the mocked transport by operation path; unrouted paths fail the test loudly. */
const byPath =
  (
    handlers: Record<
      string,
      () => { data: unknown; ok: true } | { error: unknown; ok: false }
    >
  ) =>
  (_wire: unknown, path: string) => {
    const handler = handlers[path];
    if (!handler) {
      throw new Error(`Unexpected executor path in test: ${path}`);
    }
    return Promise.resolve(handler());
  };

test("tool is exposed only for the widget support initiator", async () => {
  const resolve = definition.events["step.started"];
  assert.ok(resolve);
  assert.ok(await resolve({} as never, ctx as never));
  const results = await Promise.all(
    [null, { issuer: "slack" }, finInvestigationAuth(verifiedFinContext)].map(
      (initiator) =>
        resolve(
          {} as never,
          {
            session: { auth: { current: widgetAuth(scope), initiator } },
          } as never
        )
    )
  );
  assert.deepEqual(results, [null, null, null]);
});

test("input accepts no selector", () => {
  assert.ok(widgetInboxHealthInput.safeParse({}).success);
  assert.equal(
    widgetInboxHealthInput.safeParse({ organizationId: scope.organizationId })
      .success,
    false
  );
  assert.equal(
    widgetInboxHealthInput.safeParse({ workspaceId: WORKSPACE_ID }).success,
    false
  );
});

test("the query checks current membership and never selects credentials or a webhook URL", () => {
  const query = buildWidgetInboxHealthQuery(scope);
  for (const required of [
    scope.organizationId,
    scope.userId,
    "m.deleted_at is null",
    "o.deleted_at is null",
    "m.role in ('owner', 'admin')",
    "o.partner_id",
    "join authorized a on a.id = p.organization_id",
    "count(*) = 1",
    "p.provider = 'instantly'",
  ]) {
    assert.ok(query.includes(required), required);
  }
  for (const forbidden of [
    "credentials",
    "credential_hash",
    "select *",
    "w.url",
  ]) {
    assert.equal(query.includes(forbidden), false, forbidden);
  }
});

test("no connection is reported distinctly from an unreadable connection", async (t) => {
  t.mock.method(
    executorTransport,
    "call",
    byPath({ [DB_PATH]: () => ({ data: dbEnvelope(baseRow()), ok: true }) })
  );
  const result = await readWidgetInboxHealth(ctx);
  assert.ok(widgetInboxHealthOutput.safeParse(result).success);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    return;
  }
  assert.equal(result.connection, null);
  assert.equal(result.webhook, null);
  assert.equal(result.accounts.available, false);
  if (result.accounts.available === false) {
    assert.match(result.accounts.reason, NO_CONNECTION);
  }
});

test("a user-managed connection reports saved facts but skips the live account check", async (t) => {
  const row = baseRow({
    accountType: "user_owned",
    connectionUpdatedAt: observedAt,
    hasConnectionError: false,
    isActive: true,
    webhookRegisteredCount: 1,
    workspaceId: WORKSPACE_ID,
  });
  t.mock.method(
    executorTransport,
    "call",
    byPath({ [DB_PATH]: () => ({ data: dbEnvelope(row), ok: true }) })
  );
  const result = await readWidgetInboxHealth(ctx);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    return;
  }
  assert.equal(result.connection?.accountType, "user_owned");
  assert.equal(result.webhook?.registeredCount, 1);
  assert.equal(result.accounts.available, false);
  if (result.accounts.available === false) {
    assert.match(result.accounts.reason, USER_MANAGED);
  }
});

test("an inactive connection skips the live account check without calling Instantly", async (t) => {
  const row = baseRow({
    accountType: "system_provisioned",
    connectionUpdatedAt: observedAt,
    hasConnectionError: true,
    isActive: false,
    workspaceId: WORKSPACE_ID,
  });
  t.mock.method(
    executorTransport,
    "call",
    byPath({ [DB_PATH]: () => ({ data: dbEnvelope(row), ok: true }) })
  );
  const result = await readWidgetInboxHealth(ctx);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    return;
  }
  assert.equal(result.connection?.isActive, false);
  assert.equal(result.accounts.available, false);
  if (result.accounts.available === false) {
    assert.match(result.accounts.reason, TURNED_OFF);
  }
});

test("a system-provisioned active connection runs a live check and flags the stale-sync mismatch", async (t) => {
  const row = baseRow({
    accountType: "system_provisioned",
    connectionUpdatedAt: observedAt,
    hasConnectionError: false,
    initialWarmupEmails: ["warmup@example.test"],
    isActive: true,
    lastWebhookEventAt: observedAt,
    recentWebhookErrorCount: 1,
    recentWebhookEventCount: 5,
    webhookRegisteredCount: 1,
    workspaceId: WORKSPACE_ID,
  });
  const now = new Date(observedAt).getTime();
  // The tool measures "recently used" against the real clock, so the clock is
  // held at the fixture's moment; otherwise this fails three days after observedAt.
  t.mock.timers.enable({ apis: ["Date"], now });
  const recent = new Date(now - 60 * 60 * 1000).toISOString();
  const stale = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const accountItems = [
    { email: "healthy@example.test", status: 1, timestamp_last_used: recent },
    {
      email: "stale-error@example.test",
      status: -1,
      timestamp_last_used: stale,
    },
    { email: "mismatch@example.test", status: -1, timestamp_last_used: recent },
    { email: "paused@example.test", status: 2, timestamp_last_used: recent },
    { email: "setup@example.test", setup_pending: true, status: 1 },
    { email: "Warmup@example.test", status: 1 },
    {
      email: "coded@example.test",
      status: 1,
      status_message: { code: "EAUTH", response: "535 secret smtp text" },
    },
    { email: "odd@example.test", status: 3 },
    { email: "nostatus@example.test" },
  ];
  t.mock.method(
    executorTransport,
    "call",
    byPath({
      [ACCOUNTS_PATH]: () => ({
        data: { items: accountItems, next_starting_after: null },
        ok: true,
      }),
      [DB_PATH]: () => ({ data: dbEnvelope(row), ok: true }),
      [MEMBERS_PATH]: () => ({
        data: {
          items: [member({ sub_workspace_id: WORKSPACE_ID })],
          next_starting_after: null,
        },
        ok: true,
      }),
    })
  );
  const result = await readWidgetInboxHealth(ctx);
  assert.ok(widgetInboxHealthOutput.safeParse(result).success);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    return;
  }
  assert.equal(result.webhook?.recentErrorCount, 1);
  assert.equal(result.accounts.available, true);
  if (result.accounts.available !== true) {
    return;
  }
  assert.equal(result.accounts.total, 9);
  assert.equal(result.accounts.ready, 1);
  assert.equal(result.accounts.paused, 1);
  assert.equal(result.accounts.setupPending, 1);
  assert.equal(result.accounts.initialWarmup, 1);
  // Two negative statuses plus a positive status carrying an error code.
  assert.equal(result.accounts.error, 3);
  assert.equal(result.accounts.unknown, 2);
  assert.ok(!JSON.stringify(result).includes("secret smtp"));
  assert.equal(result.accounts.staleSyncAccounts.length, 1);
  assert.equal(
    result.accounts.staleSyncAccounts[0].email,
    "mismatch@example.test"
  );
});

test("the live check follows Instantly's cursor, so counts cover every account, not the first page", async (t) => {
  const row = baseRow({
    accountType: "system_provisioned",
    connectionUpdatedAt: observedAt,
    hasConnectionError: false,
    isActive: true,
    workspaceId: WORKSPACE_ID,
  });
  // Page one alone is 2 healthy accounts: read by itself it said "all healthy"
  // while the broken inbox sat on the next page.
  const pages = [
    {
      items: [
        { email: "a@example.test", status: 1 },
        { email: "b@example.test", status: 1 },
      ],
      next_starting_after: "cursor-1",
    },
    {
      items: [{ email: "c@example.test", status: -1 }],
      next_starting_after: null,
    },
  ];
  let reads = 0;
  t.mock.method(
    executorTransport,
    "call",
    byPath({
      [ACCOUNTS_PATH]: () => {
        const data = pages[reads];
        reads += 1;
        return { data, ok: true };
      },
      [DB_PATH]: () => ({ data: dbEnvelope(row), ok: true }),
      [MEMBERS_PATH]: () => ({
        data: {
          items: [member({ sub_workspace_id: WORKSPACE_ID })],
          next_starting_after: null,
        },
        ok: true,
      }),
    })
  );
  const result = await readWidgetInboxHealth(ctx);
  assert.equal(result.status, "ok");
  if (result.status !== "ok" || result.accounts.available !== true) {
    return assert.fail("live check did not run");
  }
  assert.equal(reads, 2);
  assert.deepEqual(
    [result.accounts.total, result.accounts.error, result.accounts.truncated],
    [3, 1, false]
  );
});

test("a workspace larger than the page bound is reported as a sample, never as complete", async (t) => {
  const row = baseRow({
    accountType: "system_provisioned",
    connectionUpdatedAt: observedAt,
    hasConnectionError: false,
    isActive: true,
    workspaceId: WORKSPACE_ID,
  });
  t.mock.method(
    executorTransport,
    "call",
    byPath({
      [ACCOUNTS_PATH]: () => ({
        data: {
          items: [{ email: "a@example.test", status: 1 }],
          next_starting_after: "more",
        },
        ok: true,
      }),
      [DB_PATH]: () => ({ data: dbEnvelope(row), ok: true }),
      [MEMBERS_PATH]: () => ({
        data: {
          items: [member({ sub_workspace_id: WORKSPACE_ID })],
          next_starting_after: null,
        },
        ok: true,
      }),
    })
  );
  const result = await readWidgetInboxHealth(ctx);
  if (result.status !== "ok" || result.accounts.available !== true) {
    return assert.fail("live check did not run");
  }
  assert.equal(result.accounts.truncated, true);
  assert.equal(result.accounts.total, 10);
});

test("an Instantly failure leaves the live check unavailable without failing the whole read", async (t) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  const row = baseRow({
    accountType: "system_provisioned",
    connectionUpdatedAt: observedAt,
    hasConnectionError: false,
    isActive: true,
    webhookRegisteredCount: 1,
    workspaceId: WORKSPACE_ID,
  });
  t.mock.method(
    executorTransport,
    "call",
    byPath({
      [DB_PATH]: () => ({ data: dbEnvelope(row), ok: true }),
      [MEMBERS_PATH]: () => ({
        error: { code: "oauth_reauth_required", status: 403 },
        ok: false,
      }),
    })
  );
  const result = await readWidgetInboxHealth(ctx);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    return;
  }
  assert.equal(result.connection?.accountType, "system_provisioned");
  assert.equal(result.accounts.available, false);
  assert.ok(warning.mock.callCount() > 0);
});

test("an unauthorized workspace is denied", async (t) => {
  t.mock.method(
    executorTransport,
    "call",
    byPath({
      [DB_PATH]: () => ({
        data: dbEnvelope(baseRow({ authorized: false })),
        ok: true,
      }),
    })
  );
  const denied = await readWidgetInboxHealth(ctx);
  assert.equal(denied.status, "denied");
});

test("a failed database read is unavailable without leaking upstream detail", async (t) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  t.mock.method(executorTransport, "call", async () => ({
    error: { code: "oauth_reauth_required", message: "secret upstream detail" },
    ok: false,
  }));
  const failed = await readWidgetInboxHealth(ctx);
  assert.equal(failed.status, "unavailable");
  assert.equal(JSON.stringify(failed).includes("secret"), false);
  assert.equal(warning.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(String(warning.mock.calls[0].arguments[0])), {
    code: "transport",
    event: "widget.support.inbox_health.failed",
    outcome: "error",
    tool: "widget_inbox_health",
  });
});

test("non-widget sessions are refused before any dispatch", async (t) => {
  t.mock.method(executorTransport, "call", () =>
    assert.fail("must not dispatch")
  );
  await assert.rejects(
    readWidgetInboxHealth({
      ...ctx,
      session: {
        auth: {
          current: null,
          initiator: finInvestigationAuth(verifiedFinContext),
        },
      },
    } as unknown as ProviderContext)
  );
});

test("a cut-off warmup list leaves active accounts unknown instead of ready", async (t) => {
  const row = baseRow({
    accountType: "system_provisioned",
    initialWarmupEmails: Array.from(
      { length: 1001 },
      (_, index) => `w${index}@example.test`
    ),
    isActive: true,
    workspaceId: WORKSPACE_ID,
  });
  t.mock.method(
    executorTransport,
    "call",
    byPath({
      [ACCOUNTS_PATH]: () => ({
        data: {
          items: [
            { email: "w0@example.test", status: 1 },
            { email: "other@example.test", status: 1 },
          ],
          next_starting_after: null,
        },
        ok: true,
      }),
      [DB_PATH]: () => ({ data: dbEnvelope(row), ok: true }),
      [MEMBERS_PATH]: () => ({
        data: {
          items: [member({ sub_workspace_id: WORKSPACE_ID })],
          next_starting_after: null,
        },
        ok: true,
      }),
    })
  );
  const result = await readWidgetInboxHealth(ctx);
  if (result.status !== "ok" || result.accounts.available !== true) {
    assert.fail("expected a live account read");
  }
  assert.equal(result.accounts.initialWarmup, 1);
  assert.equal(result.accounts.ready, 0);
  assert.equal(result.accounts.unknown, 1);
});
