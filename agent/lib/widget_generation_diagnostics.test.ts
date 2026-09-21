import assert from "node:assert/strict";
import { after, type TestContext, test } from "node:test";
import type { ProviderContext } from "#lib/executor/dispatch.js";
import { WIDGET_TOOLKIT } from "#lib/executor/endpoint.js";
import { executorTransport } from "#lib/executor/transport.js";
import { verifiedFinContext } from "#lib/fin-investigation.fixture.js";
import { finInvestigationAuth } from "#lib/fin-investigation-auth.js";
import { verifiedWidgetContext } from "#lib/widget.fixture.js";
import { widgetAuth } from "#lib/widget-scope.js";
import definition, {
  buildGenerationDiagnosticsQuery,
  parseExecutions,
  readWidgetGenerationDiagnostics,
  sanitizeErrorClass,
  toSignals,
  widgetGenerationDiagnosticsInput,
  widgetGenerationDiagnosticsOutput,
} from "../tools/widget_generation_diagnostics.js";

const scope = verifiedWidgetContext;
const foreignOrg = "99999999-9999-4999-8999-999999999999";
const threadId = "44444444-4444-4444-8444-444444444444";
const PLANETSCALE_PATH =
  "planetscale.org.foremanPlanetscale.planetscale_execute_read_query";
const SENTRY_PATH = "sentry.user.personalSentry.search_issues";
const AXIOM_PATH = "axiom.user.personalAxiom.querydataset";

const saved = {
  axiom: process.env.WIDGET_AXIOM_APP_DATASET,
  bindings: process.env.EXECUTOR_OPERATION_BINDINGS,
  connector: process.env.EXECUTOR_MCP_CONNECTOR,
  sentry: process.env.WIDGET_SENTRY_ORG_SLUG,
};
process.env.EXECUTOR_MCP_CONNECTOR = "executor.test/widget";
process.env.EXECUTOR_OPERATION_BINDINGS = JSON.stringify({
  "planetscale.readQuery": { path: PLANETSCALE_PATH },
});
process.env.WIDGET_SENTRY_ORG_SLUG = "acquisity-monitoring";
process.env.WIDGET_AXIOM_APP_DATASET = "acquisity-app-logs";
const restore = (key: keyof typeof saved, name: string) => {
  if (saved[key] === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = saved[key];
  }
};
after(() => {
  restore("connector", "EXECUTOR_MCP_CONNECTOR");
  restore("bindings", "EXECUTOR_OPERATION_BINDINGS");
  restore("sentry", "WIDGET_SENTRY_ORG_SLUG");
  restore("axiom", "WIDGET_AXIOM_APP_DATASET");
});

const t1 = "2026-09-17T09:00:00.000Z";
const t2 = "2026-09-17T09:05:00.000Z";
const t3 = "2026-09-17T09:10:00.000Z";
const t4 = "2026-09-17T09:15:00.000Z";
const observedAt = "2026-09-17T10:00:00.000Z";

const dbRows = [
  {
    agentName: "copy-review",
    hadError: false,
    issueTypes: ["fabricated_url", "not_a_real_issue_type"],
    passed: false,
    startedAt: t1,
    success: true,
  },
  {
    agentName: "copy-review",
    hadError: false,
    issueTypes: [],
    passed: true,
    startedAt: t2,
    success: true,
  },
  {
    agentName: "copywriter",
    hadError: true,
    issueTypes: null,
    passed: null,
    startedAt: t3,
    success: false,
  },
  {
    agentName: "send-email",
    hadError: false,
    issueTypes: null,
    passed: null,
    startedAt: t4,
    success: true,
  },
];

const dbEnvelope = (
  records: unknown[],
  options: { authorized?: boolean } = {}
) => ({
  content: [
    {
      text: JSON.stringify({
        rows: [{ authorized: options.authorized ?? true, observedAt, records }],
        success: true,
      }),
      type: "text",
    },
  ],
});
const mcp = (payload: unknown) => ({
  content: [{ text: JSON.stringify(payload), type: "text" }],
});
const sentryPayload = {
  issues: [
    {
      count: 5,
      lastSeen: t1,
      tags: { organizationId: scope.organizationId },
      title: "TypeError: undefined signOffName in generated body",
    },
    {
      count: 3,
      lastSeen: t2,
      tags: { organizationId: scope.organizationId },
      title: "Empty model response for Ask AI",
    },
  ],
};
const foreignSentryIssue = {
  count: 40,
  lastSeen: t3,
  tags: { organizationId: foreignOrg },
  title: `OtherWorkspaceError: leaked detail for ${scope.organizationId}`,
};
const axiomPayload = {
  rows: [
    {
      _time: t2,
      count: "4",
      errorClass: "GenerationTimeoutError",
      organizationId: scope.organizationId,
    },
  ],
};

const ctx = {
  abortSignal: new AbortController().signal,
  getToken: async () => ({ token: "test-token" }),
  session: { auth: { current: null, initiator: widgetAuth(scope) } },
} as unknown as ProviderContext;

const IDENT = /^[A-Za-z0-9_.$-]+$/;
const respond = (
  responses: { axiom?: unknown; db?: unknown; sentry?: unknown },
  path: string
): Promise<unknown> => {
  const byPath: Record<string, unknown> = {
    [SENTRY_PATH]: responses.sentry,
    [AXIOM_PATH]: responses.axiom,
  };
  const source = path in byPath ? byPath[path] : responses.db;
  if (source instanceof Error) {
    return Promise.reject(source);
  }
  return Promise.resolve({ data: source, ok: true });
};
const mockTransport = (
  t: TestContext,
  responses: { axiom?: unknown; db?: unknown; sentry?: unknown }
) =>
  t.mock.method(executorTransport, "call", (_wire: unknown, path: string) =>
    respond(responses, path)
  );

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

test("inputs accept only bounded window and owned selectors", () => {
  for (const input of [
    { organizationId: scope.organizationId },
    { query: "select * from agent_executions" },
    { since: "1y" },
    { agent: "copy review; drop table" },
    { agent: "Copy-Review" },
    { threadId: "x' or true --" },
  ]) {
    assert.equal(
      widgetGenerationDiagnosticsInput.safeParse(input).success,
      false
    );
  }
  assert.ok(widgetGenerationDiagnosticsInput.safeParse({}).success);
  assert.ok(
    widgetGenerationDiagnosticsInput.safeParse({ since: "24h" }).success
  );
  assert.ok(
    widgetGenerationDiagnosticsInput.safeParse({ agent: "copy-review" }).success
  );
  assert.ok(widgetGenerationDiagnosticsInput.safeParse({ threadId }).success);
});

test("every statement checks membership, scopes to the org, and hides raw bodies", () => {
  for (const input of [
    {},
    { since: "24h" },
    { agent: "copy-review" },
    { threadId },
  ]) {
    const query = buildGenerationDiagnosticsQuery(
      scope,
      widgetGenerationDiagnosticsInput.parse(input)
    );
    for (const required of [
      scope.organizationId,
      scope.userId,
      "m.deleted_at is null",
      "o.deleted_at is null",
      "m.role in ('owner', 'admin')",
      "o.partner_id",
      "join authorized au on au.id = a.organization_id",
      "count(*) = 1",
      "a.started_at > current_timestamp - interval",
    ]) {
      assert.ok(query.includes(required), required);
    }
    for (const forbidden of [
      "select *",
      "a.reasoning",
      "a.input",
      "a.model",
      "a.trace_id",
      "reasoning as",
    ]) {
      assert.equal(query.includes(forbidden), false, forbidden);
    }
  }
  assert.ok(
    buildGenerationDiagnosticsQuery(scope, { agent: "copy-review" }).includes(
      "and a.agent_name = 'copy-review'"
    )
  );
  assert.ok(
    buildGenerationDiagnosticsQuery(scope, { threadId }).includes(
      `and a.thread_id = '${threadId}'::uuid`
    )
  );
});

test("dispatch sends the org-scoped query through the widget toolkit", async (t) => {
  const call = mockTransport(t, {
    axiom: mcp(axiomPayload),
    db: dbEnvelope(dbRows),
    sentry: mcp(sentryPayload),
  });
  const result = await readWidgetGenerationDiagnostics(ctx, {});
  assert.equal(result.status, "ok");
  const dbCall = call.mock.calls.find(
    (entry) => (entry.arguments as unknown[])[1] === PLANETSCALE_PATH
  );
  assert.ok(dbCall);
  const [wire, , input] = dbCall.arguments as unknown as [
    { toolkit?: string },
    string,
    { query: string; use_replica: boolean },
  ];
  assert.equal(wire.toolkit, WIDGET_TOOLKIT);
  assert.ok(input.query.includes(scope.organizationId));
  assert.equal(input.use_replica, false);
  const sentryCall = call.mock.calls.find(
    (entry) => (entry.arguments as unknown[])[1] === SENTRY_PATH
  );
  assert.ok(sentryCall);
  // The live search_issues contract: required slug, separate period, explicit syntax only.
  assert.deepEqual((sentryCall.arguments as unknown[])[2], {
    limit: 20,
    organizationSlug: "acquisity-monitoring",
    period: "7d",
    query: `is:unresolved organizationId:${scope.organizationId}`,
    sort: "freq",
  });
});

test("output matches the schema, aggregates copy-review, and sanitizes org-gated signals", async (t) => {
  mockTransport(t, {
    axiom: mcp(axiomPayload),
    db: dbEnvelope(dbRows),
    sentry: mcp(sentryPayload),
  });
  const result = await readWidgetGenerationDiagnostics(ctx, { since: "7d" });
  assert.ok(widgetGenerationDiagnosticsOutput.safeParse(result).success);
  if (result.status !== "ok") {
    assert.fail("expected ok");
  }
  assert.equal(result.window, "7d");
  assert.equal(result.workspace, scope.organizationName);
  assert.equal(result.executions.copyReview.passes, 1);
  assert.equal(result.executions.copyReview.blocks, 1);
  assert.deepEqual(result.executions.copyReview.blockedIssueTypes, [
    { count: 1, type: "fabricated_url" },
  ]);
  assert.equal(result.executions.decisions.length, 4);
  assert.ok(
    result.executions.decisions.some((entry) => entry.outcome === "block")
  );
  assert.deepEqual(result.executions.failuresByAgent, [
    { agentName: "copywriter", failures: 1, lastSeen: t3 },
  ]);

  assert.equal(result.signals.sentry.status, "ok");
  assert.equal(result.signals.axiom.status, "ok");
  const classes = [
    ...result.signals.sentry.items,
    ...result.signals.axiom.items,
  ].map((item) => item.errorClass);
  assert.ok(classes.includes("TypeError"));
  assert.ok(classes.includes("GenerationTimeoutError"));
  assert.ok(
    result.signals.sentry.items.some((item) => item.kind === "empty_response")
  );
  // Every raw message is dropped.
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("undefined signOffName"), false);
  for (const item of [
    ...result.signals.sentry.items,
    ...result.signals.axiom.items,
  ]) {
    assert.match(item.errorClass, IDENT);
  }
});

test("denied, unavailable and malformed stay distinct without leaking values", async (t) => {
  const denied = parseExecutions(dbEnvelope(dbRows, { authorized: false }));
  assert.equal("status" in denied && denied.status, "denied");

  const warn1 = t.mock.method(console, "warn", () => undefined);
  const fail = mockTransport(t, { db: undefined });
  fail.mock.mockImplementation((_wire: unknown, path: string) =>
    path === PLANETSCALE_PATH
      ? Promise.resolve({
          error: { code: "oauth_reauth_required", message: "secret upstream" },
          ok: false,
        })
      : Promise.resolve({ data: mcp({ rows: [] }), ok: true })
  );
  const unavailable = await readWidgetGenerationDiagnostics(ctx, {});
  assert.equal(unavailable.status, "unavailable");
  assert.equal(JSON.stringify(unavailable).includes("secret"), false);
  assert.equal(
    JSON.parse(String(warn1.mock.calls[0].arguments[0])).code,
    "transport"
  );

  const warn2 = t.mock.method(console, "warn", () => undefined);
  mockTransport(t, {
    axiom: mcp(axiomPayload),
    db: dbEnvelope([{ ...dbRows[0], startedAt: "secret-not-a-timestamp" }]),
    sentry: mcp(sentryPayload),
  });
  const malformed = await readWidgetGenerationDiagnostics(ctx, {});
  assert.equal(malformed.status, "unavailable");
  assert.equal(JSON.stringify(malformed).includes("secret"), false);
  assert.equal(
    JSON.parse(String(warn2.mock.calls[0].arguments[0])).code,
    "response"
  );
});

test("a signal source is unavailable, never empty, when it errors or is unconfigured", async (t) => {
  const withError = mockTransport(t, {
    axiom: new Error("axiom exploded"),
    db: dbEnvelope(dbRows),
    sentry: new Error("sentry exploded"),
  });
  const errored = await readWidgetGenerationDiagnostics(ctx, {});
  assert.equal(errored.status, "ok");
  if (errored.status === "ok") {
    assert.equal(errored.signals.sentry.status, "unavailable");
    assert.equal(errored.signals.axiom.status, "unavailable");
    assert.deepEqual(errored.signals.sentry.items, []);
  }
  withError.mock.restore();

  delete process.env.WIDGET_SENTRY_ORG_SLUG;
  delete process.env.WIDGET_AXIOM_APP_DATASET;
  const unconfigured = mockTransport(t, { db: dbEnvelope(dbRows) });
  const result = await readWidgetGenerationDiagnostics(ctx, {});
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.signals.sentry.status, "unavailable");
    assert.equal(result.signals.axiom.status, "unavailable");
  }
  // Neither Sentry nor Axiom was dispatched once their config was absent.
  assert.equal(
    unconfigured.mock.calls.every(
      (entry) => (entry.arguments as unknown[])[1] === PLANETSCALE_PATH
    ),
    true
  );
  process.env.WIDGET_SENTRY_ORG_SLUG = "acquisity-monitoring";
  process.env.WIDGET_AXIOM_APP_DATASET = "acquisity-app-logs";
});

test("sanitizeErrorClass strips messages", () => {
  assert.equal(
    sanitizeErrorClass("TypeError: bad thing at file.ts:12"),
    "TypeError"
  );
  assert.equal(sanitizeErrorClass("  "), "UnknownError");
  assert.equal(sanitizeErrorClass({ not: "a string" }), "UnknownError");
});

const mine = {
  count: 2,
  errorClass: "MineError",
  lastSeen: t1,
  organizationId: scope.organizationId,
};
const unavailable = { items: [], status: "unavailable" };

test("toSignals accepts only exact structured ownership", () => {
  const owned = toSignals(
    [
      mine,
      { count: 1, tags: { organizationId: scope.organizationId }, title: "A" },
      {
        count: 1,
        tags: [{ key: "organizationId", value: scope.organizationId }],
        title: "B",
      },
    ],
    scope
  );
  assert.equal(owned.status, "ok");
  assert.deepEqual(owned.items.map((item) => item.errorClass).sort(), [
    "A",
    "B",
    "MineError",
  ]);
  // A genuinely scoped empty result is a real zero.
  assert.deepEqual(toSignals([], scope), { items: [], status: "ok" });
});

test("toSignals refuses foreign, unowned and malformed rows instead of reporting a count", () => {
  const cases: Record<string, unknown[] | null> = {
    "conflicting owners": [{ ...mine, tags: { organizationId: foreignOrg } }],
    "foreign row whose text mentions this workspace": [
      mine,
      {
        count: 9,
        errorClass: "TheirError",
        message: `failure while reading ${scope.organizationId}`,
        organizationId: foreignOrg,
      },
    ],
    "foreign tag with this workspace only in the title": [foreignSentryIssue],
    "missing ownership": [
      { count: 3, message: scope.organizationId, title: "NoOwnerError" },
    ],
    "non-object row": [mine, "not an object"],
    "non-string owner": [{ ...mine, organizationId: [scope.organizationId] }],
    "unrecognized shape": null,
  };
  for (const [name, rows] of Object.entries(cases)) {
    assert.deepEqual(toSignals(rows, scope), unavailable, name);
  }
});

test("signal sources stay inconclusive end to end unless ownership is verified", async (t) => {
  const sentryMarkdown = {
    content: [
      {
        text: `# Search Results for "is:unresolved organizationId:${scope.organizationId}"\n\nFound **1** issues:\n\n## 1. [ACQUISITY-1](https://x.sentry.io/issues/ACQUISITY-1)\n\n**OtherWorkspaceError: leaked detail**\n\n- **Events**: 40`,
        type: "text",
      },
    ],
  };
  const cases: { axiom: unknown; sentry: unknown; want: string }[] = [
    // The live Sentry MCP answers in markdown with no per-issue owner.
    {
      axiom: mcp({ unexpected: true }),
      sentry: sentryMarkdown,
      want: "unavailable",
    },
    {
      axiom: mcp({ rows: [{ count: 1, errorClass: "NoOwnerError" }] }),
      sentry: mcp({ issues: [...sentryPayload.issues, foreignSentryIssue] }),
      want: "unavailable",
    },
    { axiom: mcp({ rows: [] }), sentry: mcp({ issues: [] }), want: "ok" },
  ];
  for (const { axiom, sentry, want } of cases) {
    const transport = mockTransport(t, {
      axiom,
      db: dbEnvelope(dbRows),
      sentry,
    });
    // biome-ignore lint/performance/noAwaitInLoops: each case swaps the one shared transport mock.
    const result = await readWidgetGenerationDiagnostics(ctx, {});
    transport.mock.restore();
    if (result.status !== "ok") {
      assert.fail("expected ok");
    }
    assert.equal(result.signals.sentry.status, want);
    assert.equal(result.signals.axiom.status, want);
    assert.deepEqual(result.signals.sentry.items, []);
    assert.deepEqual(result.signals.axiom.items, []);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("leaked detail"), false);
    assert.equal(serialized.includes(foreignOrg), false);
  }
});

test("non-widget sessions are refused before any dispatch", async (t) => {
  t.mock.method(executorTransport, "call", () =>
    assert.fail("must not dispatch")
  );
  await assert.rejects(
    readWidgetGenerationDiagnostics(
      {
        ...ctx,
        session: {
          auth: {
            current: null,
            initiator: finInvestigationAuth(verifiedFinContext),
          },
        },
      } as unknown as ProviderContext,
      {}
    )
  );
});
