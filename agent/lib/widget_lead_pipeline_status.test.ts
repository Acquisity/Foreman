import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import type { ProviderContext } from "#lib/executor/dispatch.js";
import { WIDGET_TOOLKIT } from "#lib/executor/endpoint.js";
import { executorTransport } from "#lib/executor/transport.js";
import { verifiedFinContext } from "#lib/fin-investigation.fixture.js";
import { finInvestigationAuth } from "#lib/fin-investigation-auth.js";
import { verifiedWidgetContext } from "#lib/widget.fixture.js";
import { widgetAuth } from "#lib/widget-scope.js";
import definition, {
  buildWidgetLeadPipelineQuery,
  parseWidgetLeadPipelineEvidence,
  readWidgetLeadPipelineStatus,
  widgetLeadPipelineInput,
  widgetLeadPipelineOutput,
} from "../tools/widget_lead_pipeline_status.js";

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

const runId = "44444444-4444-4444-8444-444444444444";
const observedAt = "2026-09-17T10:00:00.000Z";
const scrapeRun = {
  action: "upload_to_campaign",
  campaignId: null,
  declaredLeadCount: 500,
  finishedAt: null,
  id: runId,
  name: "Selected lead list",
  runId: "apify-run-abc123",
  source: "apollo",
  startedAt: observedAt,
  status: "running",
  storedLeadCount: 0,
  stuck: true,
  unverifiedLeadCount: 0,
  updatedAt: observedAt,
  verificationJobs: { completed: 0, failed: 0, pending: 1, unknown: 0 },
  verifiedLeadCount: 0,
};
const importActivity = {
  campaignLeadCount: 1200,
  campaignsWithLeads: 3,
  ingestionCreditsUsed: 1200,
  ingestionCreditTransactions: 4,
};
const reconciliationTotals = {
  campaignLeadStoredTotal: 1200,
  scrapeLeadStoredTotal: 800,
  scrapeRunDeclaredTotal: 900,
};
const envelope = (
  overrides: {
    authorized?: boolean;
    importActivity?: unknown;
    reconciliation?: unknown;
    scrapeRuns?: unknown[];
  } = {}
) => ({
  content: [
    {
      text: JSON.stringify({
        rows: [
          {
            authorized: overrides.authorized ?? true,
            importActivity:
              overrides.importActivity === undefined
                ? importActivity
                : overrides.importActivity,
            observedAt,
            reconciliation:
              overrides.reconciliation === undefined
                ? reconciliationTotals
                : overrides.reconciliation,
            scrapeRuns: overrides.scrapeRuns ?? [scrapeRun],
          },
        ],
        success: true,
      }),
      type: "text",
    },
  ],
});
const ctx = {
  abortSignal: new AbortController().signal,
  getToken: async () => ({ token: "test-token" }),
  session: { auth: { current: null, initiator: widgetAuth(scope) } },
} as unknown as ProviderContext;

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

test("inputs accept only a bounded window", () => {
  for (const input of [
    { organizationId: scope.organizationId },
    { query: "select * from lead_scrape_lead" },
    { sinceDays: 0 },
    { sinceDays: 91 },
    { sinceDays: 1.5 },
    { sinceDays: "30" },
  ]) {
    assert.equal(widgetLeadPipelineInput.safeParse(input).success, false);
    assert.throws(() => buildWidgetLeadPipelineQuery(scope, input as never));
  }
  assert.ok(widgetLeadPipelineInput.safeParse({}).success);
  assert.ok(widgetLeadPipelineInput.safeParse({ sinceDays: 7 }).success);
});

test("every statement checks membership and scopes every product join to the organization", () => {
  for (const input of [{}, { sinceDays: 7 }]) {
    const query = buildWidgetLeadPipelineQuery(scope, input);
    for (const required of [
      scope.organizationId,
      scope.userId,
      "m.deleted_at is null",
      "o.deleted_at is null",
      "m.role in ('owner', 'admin')",
      "o.partner_id",
      "count(*) = 1",
      "join authorized a on a.id = lsr.organization_id",
      "lsl.organization_id = lsr.organization_id",
      "join authorized a on a.id = ocl.organization_id",
      "join authorized a on a.id = ct.organization_id",
      "join authorized a on a.id = lsl.organization_id",
      "ocl.deleted_at is null",
    ]) {
      assert.ok(query.includes(required), required);
    }
    for (const forbidden of [
      "select *",
      "lsl.email",
      "lsl.raw_data",
      "ocl.email",
      "ocl.custom_fields",
      "ct.stripe_payment_intent_id",
      "lsr.input",
      "lsr.metadata",
    ]) {
      assert.equal(query.includes(forbidden), false, forbidden);
    }
  }
  assert.ok(
    buildWidgetLeadPipelineQuery(scope, { sinceDays: 14 }).includes(
      "make_interval(days => 14)"
    )
  );
  assert.ok(
    buildWidgetLeadPipelineQuery(scope, {}).includes(
      "make_interval(days => 30)"
    )
  );
});

test("dispatch sends the org-scoped query through the widget toolkit", async (t) => {
  const call = t.mock.method(executorTransport, "call", async () => ({
    data: envelope(),
    ok: true,
  }));
  const result = await readWidgetLeadPipelineStatus(ctx, {});
  assert.equal(result.status, "ok");
  assert.equal(call.mock.callCount(), 1);
  const [wire, path, input] = call.mock.calls[0].arguments as unknown as [
    { toolkit?: string },
    string,
    { query: string; use_replica: boolean },
  ];
  assert.equal(wire.toolkit, WIDGET_TOOLKIT);
  assert.equal(
    path,
    "planetscale.org.foremanPlanetscale.planetscale_execute_read_query"
  );
  assert.ok(input.query.includes(scope.organizationId));
  assert.equal(input.use_replica, false);
});

test("output matches the schema and carries a reconciliation discrepancy", () => {
  const result = parseWidgetLeadPipelineEvidence(envelope(), scope, {});
  assert.ok(widgetLeadPipelineOutput.safeParse(result).success);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    assert.fail("Expected ok evidence");
  }
  assert.equal(result.scrapeRuns[0].stuck, true);
  assert.equal(result.scrapeRuns[0].declaredLeadCount, 500);
  assert.equal(result.scrapeRuns[0].storedLeadCount, 0);
  assert.equal(result.scrapeRuns[0].runId, "apify-run-abc123");
  assert.equal(result.importActivity.ingestionCreditsUsed, 1200);
  // 900 declared != 800 persisted -> discrepancy.
  assert.equal(result.reconciliation.discrepancy, true);
  assert.equal(result.reconciliation.campaignLeadStoredTotal, 1200);
  assert.equal(result.windowDays, 30);
  assert.equal(result.workspace, scope.organizationName);

  const reconciled = parseWidgetLeadPipelineEvidence(
    envelope({
      reconciliation: { ...reconciliationTotals, scrapeLeadStoredTotal: 900 },
    }),
    scope,
    { sinceDays: 7 }
  );
  if (reconciled.status !== "ok") {
    assert.fail("Expected ok evidence");
  }
  assert.equal(reconciled.reconciliation.discrepancy, false);
  assert.equal(reconciled.windowDays, 7);
});

test("an empty pipeline is a valid ok result, not unavailable", () => {
  const result = parseWidgetLeadPipelineEvidence(
    envelope({
      importActivity: {
        campaignLeadCount: 0,
        campaignsWithLeads: 0,
        ingestionCreditsUsed: 0,
        ingestionCreditTransactions: 0,
      },
      reconciliation: {
        campaignLeadStoredTotal: 0,
        scrapeLeadStoredTotal: 0,
        scrapeRunDeclaredTotal: 0,
      },
      scrapeRuns: [],
    }),
    scope,
    {}
  );
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    assert.fail("Expected ok evidence");
  }
  assert.deepEqual(result.scrapeRuns, []);
  assert.equal(result.reconciliation.discrepancy, false);
});

test("empty, denied and unavailable stay distinct", async (t) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  assert.equal(
    parseWidgetLeadPipelineEvidence(envelope({ authorized: false }), scope, {})
      .status,
    "denied"
  );
  t.mock.method(executorTransport, "call", async () => ({
    error: { code: "oauth_reauth_required", message: "secret upstream detail" },
    ok: false,
  }));
  const failed = await readWidgetLeadPipelineStatus(ctx, {});
  assert.equal(failed.status, "unavailable");
  assert.equal(JSON.stringify(failed).includes("secret"), false);
  assert.equal(warning.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(String(warning.mock.calls[0].arguments[0])), {
    code: "transport",
    event: "widget.support.lead_pipeline_status.failed",
    outcome: "error",
    tool: "widget_lead_pipeline_status",
  });
});

test("malformed rows become unavailable without leaking values, and extra fields are dropped", async (t) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  t.mock.method(executorTransport, "call", async () => ({
    data: envelope({
      scrapeRuns: [{ ...scrapeRun, status: "secret provider value" }],
    }),
    ok: true,
  }));
  const result = await readWidgetLeadPipelineStatus(ctx, {});
  assert.equal(result.status, "unavailable");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(
    JSON.parse(String(warning.mock.calls[0].arguments[0])).code,
    "response"
  );
  const extra = parseWidgetLeadPipelineEvidence(
    envelope({
      scrapeRuns: [
        { ...scrapeRun, email: "secret@example.com", rawData: "secret" },
      ],
    }),
    scope,
    {}
  );
  assert.equal(extra.status, "ok");
  assert.equal(JSON.stringify(extra).includes("secret"), false);
});

test("non-widget sessions are refused before any dispatch", async (t) => {
  t.mock.method(executorTransport, "call", () =>
    assert.fail("must not dispatch")
  );
  await assert.rejects(
    readWidgetLeadPipelineStatus(
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

test("the generated verification subquery counts Instantly and verified imports within the same organization", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`create table lead_scrape_run (id text, organization_id text, source text);
      create table lead_scrape_lead (scrape_run_id text, organization_id text, is_email_verified boolean);
      insert into lead_scrape_run values ('instant', 'ours', 'instantly'), ('import', 'ours', 'manual');
      insert into lead_scrape_lead values ('instant', 'ours', false), ('instant', 'ours', true),
        ('instant', 'foreign', true), ('import', 'ours', false), ('import', 'ours', true), ('import', 'foreign', true);`);
    const query = buildWidgetLeadPipelineQuery(scope, {});
    const subquery = query.slice(
      query.indexOf(
        "(select count(*) from lead_scrape_lead",
        query.indexOf('as "storedLeadCount"')
      ),
      query.indexOf('as "verifiedLeadCount"')
    );
    const rows = db
      .prepare(
        `select lsr.id, ${subquery} as verified from lead_scrape_run lsr order by lsr.id`
      )
      .all();
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        { id: "import", verified: 1 },
        { id: "instant", verified: 2 },
      ]
    );
  } finally {
    db.close();
  }
});

const STUCK_AGE = /current_timestamp - interval '\d+ minutes'/u;

test("a pending run that has not started is never stuck, so the read still parses", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`create table lead_scrape_run (id text, status text, started_at text);
      insert into lead_scrape_run values ('waiting', 'pending', null),
        ('old', 'running', '2000-01-01 00:00:00'), ('done', 'completed', '2000-01-01 00:00:00');`);
    const query = buildWidgetLeadPipelineQuery(scope, {});
    const end = query.indexOf(" as stuck,");
    const start = query.lastIndexOf('as "verificationJobs",', end);
    const predicate = query
      .slice(start + 'as "verificationJobs",'.length, end)
      .replace(STUCK_AGE, "current_timestamp");
    const rows = db
      .prepare(
        `select id, ${predicate} as stuck from lead_scrape_run lsr order by id`
      )
      .all();
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        { id: "done", stuck: 0 },
        { id: "old", stuck: 1 },
        { id: "waiting", stuck: 0 },
      ]
    );
  } finally {
    db.close();
  }
});

test("count differences in either direction do not diagnose failed processing", () => {
  for (const stored of [800, 1000]) {
    const result = parseWidgetLeadPipelineEvidence(
      envelope({
        reconciliation: {
          ...reconciliationTotals,
          scrapeLeadStoredTotal: stored,
        },
        scrapeRuns: [
          {
            ...scrapeRun,
            finishedAt: observedAt,
            status: "completed",
            stuck: false,
          },
        ],
      }),
      scope,
      {}
    );
    assert.equal(result.status, "ok");
    if (result.status !== "ok") {
      assert.fail("Expected evidence");
    }
    assert.equal(result.reconciliation.discrepancy, true);
    assert.equal(result.scrapeRuns[0].status, "completed");
    assert.ok(
      result.reconciliation.note.includes(
        "does not establish a processing failure"
      )
    );
  }
});

test("selectors remain tenant scoped and a selected old run bypasses only the time window", () => {
  const query = buildWidgetLeadPipelineQuery(scope, {
    campaignId: runId,
    scrapeRunId: runId,
  });
  assert.ok(query.includes(`lsr.id = '${runId}'::uuid`));
  assert.ok(query.includes(`lsr.campaign_id = '${runId}'::uuid`));
  assert.ok(query.includes("c.organization_id = lsr.organization_id"));
  assert.ok(query.includes("join authorized a on a.id = lsr.organization_id"));
  assert.ok(
    query.includes(
      "v.organization_id = lsr.organization_id and v.scrape_run_id = lsr.id"
    )
  );
  assert.equal(query.includes("where lsr.created_at >"), false);
  for (const input of [
    { scrapeRunId: "bad" },
    { campaignId: "bad" },
    { runId: "provider-run" },
  ]) {
    assert.equal(widgetLeadPipelineInput.safeParse(input).success, false);
  }
});

test("verification breakdown retains product semantics and provider references never dispatch to Inngest", async (t) => {
  const call = t.mock.method(executorTransport, "call", async () => ({
    data: envelope({
      scrapeRuns: [
        {
          ...scrapeRun,
          storedLeadCount: 10,
          unverifiedLeadCount: 3,
          verificationJobs: { completed: 1, failed: 1, pending: 0, unknown: 0 },
          verifiedLeadCount: 7,
        },
      ],
    }),
    ok: true,
  }));
  const result = await readWidgetLeadPipelineStatus(ctx, {
    scrapeRunId: runId,
  });
  assert.equal(call.mock.callCount(), 1);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    assert.fail("Expected saved evidence");
  }
  assert.equal(result.scrapeRuns[0].runId, "apify-run-abc123");
  assert.equal(result.scrapeRuns[0].unverifiedLeadCount, 3);
  assert.equal(result.scrapeRuns[0].verificationJobs.failed, 1);
});
