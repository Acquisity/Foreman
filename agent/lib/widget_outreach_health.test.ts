import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ProviderContext } from "#lib/executor/dispatch.js";
import { WIDGET_TOOLKIT } from "#lib/executor/endpoint.js";
import { executorTransport } from "#lib/executor/transport.js";
import { verifiedFinContext } from "#lib/fin-investigation.fixture.js";
import { finInvestigationAuth } from "#lib/fin-investigation-auth.js";
import { member, WORKSPACE_ID } from "#lib/instantly-fixtures.js";
import { verifiedWidgetContext } from "#lib/widget.fixture.js";
import { widgetAuth } from "#lib/widget-scope.js";
import definition, {
  buildWidgetOutreachHealthQuery,
  parseWidgetOutreachHealthEvidence,
  readWidgetOutreachHealth,
  widgetOutreachHealthInput,
  widgetOutreachHealthOutput,
} from "../tools/widget_outreach_health.js";

const scope = verifiedWidgetContext;
const originalConnector = process.env.EXECUTOR_MCP_CONNECTOR;
const originalBindings = process.env.EXECUTOR_OPERATION_BINDINGS;
process.env.EXECUTOR_MCP_CONNECTOR = "executor.test/widget";
process.env.EXECUTOR_OPERATION_BINDINGS = JSON.stringify({
  "instantly.campaigns": {
    path: "foreman_instantly_api.org.foremanInstantlyApi.campaigns.listCampaigns",
  },
  "instantly.workspace-group-members": {
    path: "foreman_instantly_api.org.foremanInstantlyApi.workspaceGroupMembers.listWorkspaceGroupMembers",
  },
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

const campaignId = "44444444-4444-4444-8444-444444444444";
const observedAt = "2026-09-17T10:00:00.000Z";
const inboxes = { healthyAccounts: 3, totalSendingAccounts: 5 };
const row = {
  accountType: "system_provisioned",
  dailyLimit: 35,
  days: {
    "0": false,
    "1": true,
    "2": true,
    "3": true,
    "4": true,
    "5": true,
    "6": false,
  },
  diagnostics: null,
  fromTime: "09:00",
  id: campaignId,
  leadsNotPushedCount: 12,
  name: "Customer campaign",
  notSendingStatusRaw: "1",
  provider: "instantly",
  providerCampaignId: campaignId,
  providerWorkspaceId: "e05cbe7b-67db-4b07-b712-46b9365dc83f",
  recentSends: [{ date: "2026-09-16", emailsSent: 0 }],
  status: "active",
  timezone: "Etc/GMT+12",
  toTime: "17:00",
  totalLeads: 100,
  updatedAt: observedAt,
};
const envelope = (
  records: unknown[],
  options: { authorized?: boolean; inboxes?: unknown } = {}
) => ({
  content: [
    {
      text: JSON.stringify({
        rows: [
          {
            authorized: options.authorized ?? true,
            inboxes: options.inboxes === undefined ? inboxes : options.inboxes,
            observedAt,
            records,
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

test("inputs accept an owned campaign ID or page cursor, never SQL or workspace selectors", () => {
  for (const input of [
    { organizationId: scope.organizationId },
    { query: "select * from member" },
    { after: "x' or true --" },
    { campaignId: "invalid" },
    { read: "campaigns" },
  ]) {
    assert.equal(widgetOutreachHealthInput.safeParse(input).success, false);
    assert.throws(() => buildWidgetOutreachHealthQuery(scope, input as never));
  }
  assert.ok(widgetOutreachHealthInput.safeParse({}).success);
  assert.ok(widgetOutreachHealthInput.safeParse({ after: campaignId }).success);
});

test("every statement checks membership and scopes every product join to the organization", () => {
  for (const input of [{}, { after: campaignId }]) {
    const query = buildWidgetOutreachHealthQuery(scope, input);
    for (const required of [
      scope.organizationId,
      scope.userId,
      "m.deleted_at is null",
      "o.deleted_at is null",
      "m.role in ('owner', 'admin')",
      "o.partner_id",
      "join authorized a on a.id = c.organization_id",
      "count(*) = 1",
      "p.organization_id = a.id",
      "cm.organization_id = c.organization_id and cm.campaign_id = c.id",
      "l.organization_id = c.organization_id and l.campaign_id = c.id",
      "l.deleted_at is null and l.provider_lead_id is null",
      "mi.organization_id",
    ]) {
      assert.ok(query.includes(required), required);
    }
    for (const forbidden of [
      "select *",
      "credentials",
      "connection_error",
      "l.email",
    ]) {
      assert.equal(query.includes(forbidden), false, forbidden);
    }
  }
  const paged = buildWidgetOutreachHealthQuery(scope, { after: campaignId });
  assert.ok(paged.includes(`c.id > '${campaignId}'::uuid`));
});

test("a paused campaign, the one that stopped sending, is listed and readable by id; drafts and archived are not", () => {
  // Live 2026-09-23: "Construction / Contractors" was Paused, so the old
  // active-only filter hid it and the customer was asked for its name.
  for (const input of [{}, { campaignId }]) {
    const query = buildWidgetOutreachHealthQuery(scope, input);
    assert.ok(
      query.includes(
        "c.display_status in ('active', 'paused', 'attention_needed', 'completed')"
      )
    );
    assert.equal(query.includes("c.display_status = 'active'"), false);
  }
});

test("dispatch sends the org-scoped query through the widget toolkit", async (t) => {
  const call = t.mock.method(executorTransport, "call", async () => ({
    data: envelope([row]),
    ok: true,
  }));
  const result = await readWidgetOutreachHealth(ctx, {});
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

test("campaign output matches the schema, maps the not-sending code and flags an inverted window", () => {
  const result = parseWidgetOutreachHealthEvidence(envelope([row]), scope);
  assert.ok(widgetOutreachHealthOutput.safeParse(result).success);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    assert.fail("Expected ok evidence");
  }
  assert.equal(result.workspace, scope.organizationName);
  assert.equal(result.inboxes.healthyAccounts, 3);
  const [campaign] = result.campaigns;
  assert.equal(campaign.notSendingReasonCode, 1);
  assert.equal(campaign.notSendingReason, "outside_schedule_window");
  assert.equal(campaign.schedule?.invertedWindow, false);
  assert.equal(campaign.leadsNotPushedCount, 12);
  assert.equal(campaign.savedDailyLimitPerInbox, 35);
  // The column's empty default is not a limit of zero.
  const unset = parseWidgetOutreachHealthEvidence(
    envelope([{ ...row, dailyLimit: 0 }]),
    scope
  );
  if (unset.status !== "ok") {
    assert.fail("Expected ok evidence");
  }
  assert.equal(unset.campaigns[0].savedDailyLimitPerInbox, null);

  const inverted = parseWidgetOutreachHealthEvidence(
    envelope([{ ...row, fromTime: "17:00", toTime: "09:00" }]),
    scope
  );
  if (inverted.status !== "ok") {
    assert.fail("Expected ok evidence");
  }
  assert.equal(inverted.campaigns[0].schedule?.invertedWindow, true);

  const unmapped = parseWidgetOutreachHealthEvidence(
    envelope([{ ...row, notSendingStatusRaw: "7" }]),
    scope
  );
  if (unmapped.status !== "ok") {
    assert.fail("Expected ok evidence");
  }
  assert.equal(unmapped.campaigns[0].notSendingReasonCode, 7);
  assert.equal(unmapped.campaigns[0].notSendingReason, null);

  const noSchedule = parseWidgetOutreachHealthEvidence(
    envelope([
      {
        ...row,
        days: null,
        fromTime: null,
        notSendingStatusRaw: null,
        timezone: null,
        toTime: null,
      },
    ]),
    scope
  );
  if (noSchedule.status !== "ok") {
    assert.fail("Expected ok evidence");
  }
  assert.equal(noSchedule.campaigns[0].schedule, null);
  assert.equal(noSchedule.campaigns[0].notSendingReasonCode, null);
});

test("campaign list paginates and stays distinct from an empty page", () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({
    ...row,
    id: `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
  }));
  const result = parseWidgetOutreachHealthEvidence(envelope(rows), scope);
  assert.ok(widgetOutreachHealthOutput.safeParse(result).success);
  if (result.status !== "ok") {
    assert.fail("Expected ok evidence");
  }
  assert.equal(result.campaigns.length, 20);
  assert.equal(result.nextAfter, rows[19].id);

  const empty = parseWidgetOutreachHealthEvidence(envelope([]), scope);
  assert.equal(empty.status, "ok");
  if (empty.status === "ok") {
    assert.deepEqual(empty.campaigns, []);
    assert.equal(empty.nextAfter, null);
  }
});

test("denied and unavailable stay distinct from an empty, successful result", async (t) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  assert.equal(
    parseWidgetOutreachHealthEvidence(
      envelope([row], { authorized: false }),
      scope
    ).status,
    "denied"
  );
  assert.equal(
    parseWidgetOutreachHealthEvidence(envelope([], { inboxes: null }), scope)
      .status,
    "denied"
  );
  t.mock.method(executorTransport, "call", async () => ({
    error: { code: "oauth_reauth_required", message: "secret upstream detail" },
    ok: false,
  }));
  const failed = await readWidgetOutreachHealth(ctx, {});
  assert.equal(failed.status, "unavailable");
  assert.notEqual(failed.status, "ok");
  assert.equal(JSON.stringify(failed).includes("secret"), false);
  assert.equal(warning.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(String(warning.mock.calls[0].arguments[0])), {
    code: "transport",
    event: "widget.support.outreach_health.failed",
    outcome: "error",
    tool: "widget_outreach_health",
  });
});

test("malformed rows become unavailable without leaking provider values", async (t) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  t.mock.method(executorTransport, "call", async () => ({
    data: envelope([{ ...row, status: "secret provider value" }]),
    ok: true,
  }));
  const result = await readWidgetOutreachHealth(ctx, {});
  assert.equal(result.status, "unavailable");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(
    JSON.parse(String(warning.mock.calls[0].arguments[0])).code,
    "response"
  );
});

test("non-widget sessions are refused before any dispatch", async (t) => {
  t.mock.method(executorTransport, "call", () =>
    assert.fail("must not dispatch")
  );
  await assert.rejects(
    readWidgetOutreachHealth(
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

test("targeted live read matches owned provider ID and keeps saved limits distinct", async (t) => {
  const call = t.mock.method(
    executorTransport,
    "call",
    (_wire: unknown, path: string, input: Record<string, unknown>) => {
      if (path.includes("planetscale")) {
        assert.ok(String(input.query).includes(`c.id = '${campaignId}'::uuid`));
        return { data: envelope([row]), ok: true };
      }
      if (path.includes("workspaceGroupMembers")) {
        return { data: { items: [member()] }, ok: true };
      }
      assert.equal(input["x-as-workspace"], WORKSPACE_ID);
      return {
        data: {
          items: [
            { daily_limit: 999, id: "other-campaign", status: 2 },
            {
              daily_limit: 150,
              id: campaignId,
              not_sending_status: 3,
              status: 1,
            },
          ],
        },
        ok: true,
      };
    }
  );
  const result = await readWidgetOutreachHealth(ctx, { campaignId });
  assert.equal(call.mock.callCount(), 3);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    assert.fail("Expected saved evidence");
  }
  const [campaign] = result.campaigns;
  assert.equal(campaign.savedDailyLimitPerInbox, 35);
  assert.equal(campaign.notSendingReasonCode, 1);
  assert.equal(campaign.live.available, true);
  if (!campaign.live.available) {
    assert.fail("Expected live evidence");
  }
  assert.equal(campaign.live.campaignDailyLimit, 150);
  assert.equal(campaign.live.notSendingReasonCode, 3);
  assert.equal(campaign.live.statusCode, 1);
});

test("live failure preserves saved evidence and user-owned connections never dispatch", async (t) => {
  const state = { accountType: "system_provisioned" };
  const call = t.mock.method(
    executorTransport,
    "call",
    (_wire: unknown, path: string) => {
      if (path.includes("planetscale")) {
        return {
          data: envelope([
            {
              ...row,
              accountType: state.accountType,
            },
          ]),
          ok: true,
        };
      }
      throw new Error("secret provider response");
    }
  );
  const failed = await readWidgetOutreachHealth(ctx, { campaignId });
  assert.equal(failed.status, "ok");
  if (failed.status !== "ok") {
    assert.fail("Expected saved evidence");
  }
  assert.equal(failed.campaigns[0].live.available, false);
  assert.equal(failed.campaigns[0].savedDailyLimitPerInbox, 35);
  assert.equal(JSON.stringify(failed).includes("secret"), false);
  state.accountType = "user_owned";
  const before = call.mock.callCount();
  await readWidgetOutreachHealth(ctx, { campaignId });
  assert.equal(call.mock.callCount() - before, 1);
});

test("a denied or absent target cannot trigger a provider read", async (t) => {
  const call = t.mock.method(executorTransport, "call", async () => ({
    data: envelope([], { authorized: false }),
    ok: true,
  }));
  assert.equal(
    (await readWidgetOutreachHealth(ctx, { campaignId })).status,
    "denied"
  );
  assert.equal(call.mock.callCount(), 1);
});

test("date windows require a selected campaign, real dates and no more than 31 inclusive days", () => {
  assert.ok(
    widgetOutreachHealthInput.safeParse({ after: null, campaignId: null })
      .success
  );
  const valid = { campaignId, endDate: "2026-09-30", startDate: "2026-09-01" };
  assert.ok(widgetOutreachHealthInput.safeParse(valid).success);
  for (const input of [
    { ...valid, campaignId: null },
    { ...valid, startDate: "2026-09-31" },
    { ...valid, endDate: null },
    { ...valid, endDate: "2026-08-31" },
    { ...valid, endDate: "2026-10-02" },
    { afterInboxId: campaignId },
  ]) {
    assert.equal(widgetOutreachHealthInput.safeParse(input).success, false);
  }
  const query = buildWidgetOutreachHealthQuery(scope, {
    ...valid,
    afterInboxId: campaignId,
  });
  assert.ok(query.includes("cm.date >= ('2026-09-01'::date)::text"));
  assert.ok(query.includes("cm.date <= ('2026-09-30'::date)::text"));
  assert.ok(
    query.includes(
      "co.organization_id = c.organization_id and co.campaign_id = c.id"
    )
  );
  assert.ok(query.includes("mi.organization_id = c.organization_id"));
  assert.ok(query.includes(`mi.id > '${campaignId}'::uuid`));
  assert.ok(query.includes("c.settings->'emailAccounts' ? mi.email"));
});

test("saved diagnostics preserve missing metrics and page assignments without truncating totals", () => {
  const accounts = Array.from({ length: 101 }, (_, index) => ({
    connected: true,
    email: `inbox${index}@example.com`,
    id: `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
    status: "active",
  }));
  const result = parseWidgetOutreachHealthEvidence(
    envelope([
      {
        ...row,
        diagnostics: {
          assignedInboxes: {
            accounts,
            configuredCount: 200,
            healthyCount: 180,
            matchedCount: 199,
            nextAfterInboxId: null,
          },
          dailyMetrics: [],
          endDate: "2026-09-30",
          overview: null,
          startDate: "2026-09-01",
        },
      },
    ]),
    scope
  );
  if (result.status !== "ok") {
    assert.fail("Expected saved diagnostics");
  }
  const details = result.campaigns[0].diagnostics;
  assert.ok(details);
  assert.equal(details.overview, null);
  assert.deepEqual(details.dailyMetrics, []);
  assert.equal(details.assignedInboxes.accounts.length, 100);
  assert.equal(details.assignedInboxes.nextAfterInboxId, accounts[99].id);
  assert.equal(details.assignedInboxes.configuredCount, 200);
  assert.equal(details.assignedInboxes.matchedCount, 199);
  assert.equal(details.assignedInboxes.healthyCount, 180);
  assert.ok(
    result.caveats.some((text) => text.includes("Neither is dispatch history"))
  );
});
