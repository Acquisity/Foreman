import assert from "node:assert/strict";
import { after, test } from "node:test";
import definition from "../tools/read_fin_outreach_evidence.js";
import {
  invokeProvider,
  type ProviderContext,
  readFinEvidence,
} from "./executor/dispatch.js";
import { executorTransport } from "./executor/transport.js";
import {
  buildFinEvidenceQuery,
  finEvidenceInput,
  parseFinEvidence,
} from "./fin-evidence.js";
import { verifiedFinContext } from "./fin-investigation.fixture.js";
import { finInvestigationAuth } from "./fin-investigation-auth.js";

const scope = verifiedFinContext;
const originalConnector = process.env.EXECUTOR_MCP_CONNECTOR;
const originalBindings = process.env.EXECUTOR_OPERATION_BINDINGS;
const bindings = JSON.stringify({
  "planetscale.readQuery": {
    path: "planetscale.org.foremanPlanetscale.planetscale_execute_read_query",
  },
});
process.env.EXECUTOR_MCP_CONNECTOR = "executor.test/fin";
process.env.EXECUTOR_OPERATION_BINDINGS = bindings;
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
const campaignId = "33333333-3333-4333-8333-333333333333";
const observedAt = "2026-09-15T20:00:00.000Z";
const CANCELLED = /cancelled/;
const row = {
  id: campaignId,
  name: "Customer campaign",
  status: "paused",
  totalLeads: 10,
  updatedAt: observedAt,
};
const envelope = (records: unknown[], authorized = true) => ({
  content: [
    {
      text: JSON.stringify({
        rows: [{ authorized, observedAt, records }],
        success: true,
      }),
      type: "text",
    },
  ],
});
const ctx = {
  abortSignal: new AbortController().signal,
  getToken: async () => ({ token: "test-token" }),
  session: { auth: { current: null, initiator: finInvestigationAuth(scope) } },
} as unknown as ProviderContext;

test("fixed evidence inputs reject SQL, provider IDs, workspace overrides and malformed UUIDs", () => {
  for (const input of [
    { organizationId: scope.organizationId, read: "connections" },
    { campaignId, query: "select * from member", read: "campaign" },
    { campaignId: "x' or true --", read: "campaign" },
    { after: "x' or true --", read: "campaigns" },
    { providerId: campaignId, read: "connections" },
    { read: "logs" },
  ]) {
    assert.equal(finEvidenceInput.safeParse(input).success, false);
    assert.throws(() => buildFinEvidenceQuery(scope, input as never));
  }
});

test("every statement checks current membership and scopes every product join", () => {
  for (const input of [
    { read: "campaigns" },
    { read: "connections" },
    { campaignId, read: "campaign" },
  ] as const) {
    const query = buildFinEvidenceQuery(scope, input);
    for (const required of [
      scope.organizationId,
      scope.userId,
      "m.deleted_at is null",
      "o.deleted_at is null",
      "m.role in ('owner', 'admin')",
      "o.partner_id",
      "join authorized a",
      "count(*) = 1",
    ]) {
      assert.ok(query.includes(required), required);
    }
    for (const forbidden of [
      "credentials",
      "select *",
      "ca.message",
      "metadata",
      "email",
    ]) {
      if (forbidden !== "email" || input.read !== "campaign") {
        assert.equal(query.includes(forbidden), false, forbidden);
      }
    }
  }
  const query = buildFinEvidenceQuery(scope, { campaignId, read: "campaign" });
  assert.ok(query.includes("p.organization_id = a.id"));
  assert.ok(
    query.includes(
      "cm.organization_id = c.organization_id and cm.campaign_id = c.id"
    )
  );
  assert.ok(
    query.includes(
      "ca.organization_id = c.organization_id and ca.campaign_id = c.id"
    )
  );
});

test("successful empty evidence stays distinct from foreign ID, denied access and provider failure", async (t) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  const empty = parseFinEvidence(envelope([]), scope, { read: "campaigns" });
  assert.equal(empty.status, "ok");
  const missing = parseFinEvidence(envelope([]), scope, {
    campaignId,
    read: "campaign",
  });
  assert.equal(missing.status, "not_available");
  assert.equal(
    parseFinEvidence(envelope([row], false), scope, { read: "campaigns" })
      .status,
    "denied"
  );
  t.mock.method(executorTransport, "call", async () => ({
    error: { code: "oauth_reauth_required", message: "secret upstream detail" },
    ok: false,
  }));
  const failed = await readFinEvidence(ctx, { read: "campaigns" });
  assert.equal(failed.status, "unavailable");
  assert.equal(JSON.stringify(failed).includes("secret"), false);
  assert.equal(JSON.stringify(failed).includes("oauth"), false);
  assert.equal(warning.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(String(warning.mock.calls[0].arguments[0])), {
    code: "transport",
    event: "fin.investigation.evidence.failed",
    outcome: "error",
    tool: "read_fin_outreach_evidence",
  });
});

test("all four product provider types coexist without losing valid rows", () => {
  const names = ["instantly", "smartlead", "apollo", "email_bison"];
  const result = parseFinEvidence(
    envelope(
      names.map((provider) => ({
        active: true,
        hasSavedConnectionError: false,
        provider,
        updatedAt: observedAt,
      }))
    ),
    scope,
    { read: "connections" }
  );
  assert.equal(result.status, "ok");
  if (result.status === "ok" && result.evidence.read === "connections") {
    assert.deepEqual(
      result.evidence.connections.map((entry) => entry.provider),
      names
    );
    assert.ok(
      result.caveats.some((value) =>
        value.includes("not when an error occurred")
      )
    );
  } else {
    assert.fail("Expected saved connections");
  }
});

test("SQL-bounded emoji campaign names survive UTF-16 validation", () => {
  for (const name of [`${"a".repeat(299)}😀`, "😀".repeat(300)]) {
    const result = parseFinEvidence(envelope([{ ...row, name }]), scope, {
      read: "campaigns",
    });
    assert.equal(result.status, "ok");
    if (result.status === "ok" && result.evidence.read === "campaigns") {
      assert.equal(result.evidence.campaigns[0].name, name);
    }
  }
});

test("missing or unexpected bindings deny before credentials and transport", async (t) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  const context = {
    ...ctx,
    getToken: () => assert.fail("must not resolve credentials"),
  };
  t.mock.method(executorTransport, "call", () =>
    assert.fail("must not dispatch")
  );
  try {
    for (const value of [
      "{}",
      "",
      "invalid",
      JSON.stringify({
        "planetscale.readQuery": { path: "other.org.account.read" },
      }),
    ]) {
      process.env.EXECUTOR_OPERATION_BINDINGS = value;
      // biome-ignore lint/performance/noAwaitInLoops: each case changes shared deployment configuration.
      const result = await readFinEvidence(context, { read: "connections" });
      assert.equal(result.status, "unavailable");
    }
    assert.equal(warning.mock.callCount(), 4);
    for (const call of warning.mock.calls) {
      assert.equal(JSON.parse(String(call.arguments[0])).code, "configuration");
    }
  } finally {
    process.env.EXECUTOR_OPERATION_BINDINGS = bindings;
  }
});

test("malformed evidence emits one sanitized warning, never provider values", async (t) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  t.mock.method(executorTransport, "call", async () => ({
    data: envelope([{ ...row, status: "secret provider value" }]),
    ok: true,
  }));
  const result = await readFinEvidence(ctx, { read: "campaigns" });
  assert.equal(result.status, "unavailable");
  assert.equal(warning.mock.callCount(), 1);
  const line = String(warning.mock.calls[0].arguments[0]);
  assert.equal(JSON.parse(line).code, "response");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(line.includes("secret"), false);
});

test("evidence resolver advertises only the immutable Fin initiator lane", async () => {
  const resolve = definition.events["step.started"];
  assert.ok(resolve);
  assert.ok(await resolve({} as never, ctx as never));
  const results = await Promise.all(
    [null, { issuer: "slack" }, { issuer: "github" }].map((initiator) =>
      resolve(
        {} as never,
        {
          session: {
            auth: { current: finInvestigationAuth(scope), initiator },
          },
        } as never
      )
    )
  );
  assert.deepEqual(results, [null, null, null]);
});

test("only permitted fields reach the model, including nested campaign evidence", () => {
  const result = parseFinEvidence(
    envelope([
      {
        ...row,
        activity: [
          {
            message: "secret",
            occurredAt: observedAt,
            otherCustomer: "secret",
            status: "paused",
          },
        ],
        credentials: "secret",
        metrics: [
          {
            date: "2026-09-15",
            emailsBounced: 0,
            emailsSent: 2,
            metadata: "secret",
            repliesReceived: 1,
            updatedAt: observedAt,
          },
        ],
      },
    ]),
    scope,
    { campaignId, read: "campaign" }
  );
  assert.equal(result.status, "ok");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.throws(() =>
    parseFinEvidence(
      envelope([
        { ...row, activity: [], id: scope.organizationId, metrics: [] },
      ]),
      scope,
      { campaignId, read: "campaign" }
    )
  );
  const connections = parseFinEvidence(
    envelope([
      {
        active: true,
        connection_error: "secret",
        hasSavedConnectionError: true,
        provider: "instantly",
        updatedAt: observedAt,
        workspace_id: "foreign",
      },
    ]),
    scope,
    { read: "connections" }
  );
  assert.equal(connections.status, "ok");
  assert.equal(JSON.stringify(connections).includes("secret"), false);
  assert.equal(JSON.stringify(connections).includes("foreign"), false);
});

test("partial, malformed and provider-error results are never valid empty evidence", () => {
  for (const data of [
    { rows: [], success: false },
    { rows: [], success: true },
    { ...envelope([]), isError: true },
    {
      rows: [{ authorized: true, observedAt, records: [] }],
      success: true,
      warnings: ["RLS hides rows"],
    },
  ]) {
    assert.throws(() => parseFinEvidence(data, scope, { read: "campaigns" }));
  }
});

test("campaign list is bounded and returns an explicit continuation", () => {
  const rows = Array.from({ length: 51 }, (_, i) => ({
    ...row,
    id: `${String(i).padStart(8, "0")}-3333-4333-8333-333333333333`,
  }));
  const result = parseFinEvidence(envelope(rows), scope, { read: "campaigns" });
  assert.equal(result.status, "ok");
  if (result.status === "ok" && result.evidence.read === "campaigns") {
    assert.equal(result.evidence.campaigns.length, 50);
    assert.equal(result.evidence.nextAfter, rows[49].id);
  } else {
    assert.fail("Expected campaign list");
  }
});

test("scoped dispatch preserves initiator despite later/current or inherited child authority", async (t) => {
  const call = t.mock.method(executorTransport, "call", async () => ({
    data: envelope([row]),
    ok: true,
  }));
  const context = {
    ...ctx,
    session: {
      auth: {
        current: finInvestigationAuth({ ...scope, organizationId: campaignId }),
        initiator: finInvestigationAuth(scope),
      },
      parent: { sessionId: "root" },
    },
  } as unknown as ProviderContext;
  assert.equal(
    (await readFinEvidence(context, { read: "campaigns" })).status,
    "ok"
  );
  const args = call.mock.calls[0].arguments as unknown as [
    unknown,
    string,
    { query: string; use_replica: boolean },
    unknown,
  ];
  assert.ok(args[2].query.includes(scope.organizationId));
  assert.equal(args[2].query.includes(campaignId), false);
  assert.equal(args[2].use_replica, false);
  await assert.rejects(
    invokeProvider(ctx, args[1], { query: "select * from member" })
  );
  assert.equal(call.mock.callCount(), 1);
});

test("invalid or absent initiator refuses before credentials and cancelled reads stay cancelled", async (t) => {
  const invalid = {
    ...ctx,
    getToken: () => assert.fail("must not resolve credentials"),
    session: {
      auth: { current: finInvestigationAuth(scope), initiator: null },
    },
  } as unknown as ProviderContext;
  await assert.rejects(readFinEvidence(invalid, { read: "connections" }));
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  t.mock.method(executorTransport, "call", () =>
    Promise.reject(controller.signal.reason)
  );
  await assert.rejects(
    readFinEvidence(
      { ...ctx, abortSignal: controller.signal },
      { read: "connections" }
    ),
    CANCELLED
  );
});
