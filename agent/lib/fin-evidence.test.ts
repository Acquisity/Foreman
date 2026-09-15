import assert from "node:assert/strict";
import { after, test } from "node:test";
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
process.env.EXECUTOR_MCP_CONNECTOR = "executor.test/fin";
after(() => {
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
