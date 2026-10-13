import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { ProviderContext } from "#lib/executor/dispatch.js";
import { WIDGET_TOOLKIT } from "#lib/executor/endpoint.js";
import { executorTransport } from "#lib/executor/transport.js";
import { resetInstantlyWorkspaceCache } from "#lib/instantly-api.js";
import { member, WORKSPACE_ID } from "#lib/instantly-fixtures.js";
import { verifiedWidgetContext } from "#lib/widget.fixture.js";
import { widgetAuth } from "#lib/widget-scope.js";
import definition, {
  buildWidgetOutreachHealthQuery,
  parseWidgetOutreachHealthEvidence,
  readEarlyFollowUps,
  readSendingRules,
  readWidgetOutreachHealth,
  widgetOutreachHealthInput,
  widgetOutreachHealthOutput,
} from "../tools/widget_outreach_health.js";

const scope = verifiedWidgetContext;
const WAITING_LEADS = /12 leads have not had a first email yet/;
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

// Resolved workspaces are cached per process; no test may see another's.
beforeEach(resetInstantlyWorkspaceCache);

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
  pauseReason: null,
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

test("dates without campaignId read every listed campaign's daily sends for the window", () => {
  // wrun_41M48DWE6T0GW384F9JHWV4AYD: the dated first call was rejected and the investigator asked the customer instead.
  const input = { endDate: "2026-09-30", startDate: "2026-09-20" };
  assert.equal(widgetOutreachHealthInput.safeParse(input).success, true);
  const query = buildWidgetOutreachHealthQuery(scope, input);
  assert.ok(
    query.includes(
      "and cm.date >= ('2026-09-20'::date)::text and cm.date <= ('2026-09-30'::date)::text"
    )
  );
  assert.ok(query.includes("order by cm.date desc limit 31"));
  assert.ok(query.includes("null::jsonb as diagnostics"));
  const lead = widgetOutreachHealthInput.safeParse({
    leadEmail: "lead@example.com",
  });
  assert.equal(lead.success, false);
  if (lead.success) {
    assert.fail("A lead's history without campaignId must be rejected");
  }
  assert.ok(lead.error.issues[0].message.includes("require campaignId"));
  assert.equal(
    widgetOutreachHealthInput.safeParse({ startDate: "2026-09-20" }).success,
    false
  );
});

test("tool is exposed only for the widget support initiator", async () => {
  const resolve = definition.events["step.started"];
  assert.ok(resolve);
  assert.ok(await resolve({} as never, ctx as never));
  const results = await Promise.all(
    [null, { issuer: "slack" }].map((initiator) =>
      resolve(
        {} as never,
        {
          session: { auth: { current: widgetAuth(scope), initiator } },
        } as never
      )
    )
  );
  assert.deepEqual(results, [null, null]);
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
    data: envelope([{ ...row, accountType: "user_owned" }]),
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
            initiator: { attributes: {}, issuer: "slack" },
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
              daily_max_leads: 40,
              email_gap: 10,
              id: campaignId,
              not_sending_status: 3,
              prioritize_new_leads: true,
              random_wait_max: 5,
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
  assert.equal(campaign.live.providerStatus, "active");
  assert.deepEqual(campaign.live.sendingRules, {
    maxNewLeadsPerDay: 40,
    minutesBetweenEmails: 10,
    newLeadsFirst: true,
    randomExtraMinutesMax: 5,
    reading:
      "New leads come first and 12 leads have not had a first email yet, so follow-ups wait until those leads get one, and pick up once the list has been contacted. At up to 40 new leads a day, that is about 1 more sending day. Acquisity sets these sending rules and they can't be changed in the product, so there is nothing for the customer to change. This is the likely reason follow-ups are low, not a certainty.",
  });
  // A Pro customer must never see the provider's name, even in authored text.
  assert.ok(!JSON.stringify(result).includes("Instantly"));
});

test("a multi-page live scan resolves the workspace group once", async (t) => {
  // Round 10c: a group walk on every page took about 20 s each and blew the scan deadline.
  let groupWalks = 0;
  const campaignPages: unknown[] = [];
  t.mock.method(
    executorTransport,
    "call",
    (_wire: unknown, path: string, input: Record<string, unknown>) => {
      if (path.includes("planetscale")) {
        return { data: envelope([row]), ok: true };
      }
      if (path.includes("workspaceGroupMembers")) {
        groupWalks += 1;
        return { data: { items: [member()] }, ok: true };
      }
      assert.equal(input["x-as-workspace"], WORKSPACE_ID);
      campaignPages.push(input.starting_after);
      return input.starting_after === "page-3"
        ? { data: { items: [{ id: campaignId, status: 1 }] }, ok: true }
        : {
            data: {
              items: [{ id: "other-campaign", status: 1 }],
              next_starting_after: `page-${campaignPages.length + 1}`,
            },
            ok: true,
          };
    }
  );
  const result = await readWidgetOutreachHealth(ctx, { campaignId });
  assert.equal(groupWalks, 1);
  assert.deepEqual(campaignPages, [undefined, "page-2", "page-3"]);
  assert.equal(
    result.status === "ok" && result.campaigns[0].live.available,
    true
  );
});

test("a resolved workspace is reused across calls for its organization only", async (t) => {
  // wrun_41M48DWE6T0GW384F9JHWV4AYD made two campaign reads; each walked the group (about 20 s) before round 11.
  let groupWalks = 0;
  t.mock.method(executorTransport, "call", (_wire: unknown, path: string) => {
    if (path.includes("planetscale")) {
      return { data: envelope([row]), ok: true };
    }
    if (path.includes("workspaceGroupMembers")) {
      groupWalks += 1;
      return { data: { items: [member()] }, ok: true };
    }
    return { data: { items: [{ id: campaignId, status: 1 }] }, ok: true };
  });
  await readWidgetOutreachHealth(ctx, {});
  await readWidgetOutreachHealth(ctx, { campaignId });
  assert.equal(groupWalks, 1);
  const otherOrganization = {
    ...ctx,
    session: {
      auth: {
        current: null,
        initiator: widgetAuth({
          ...scope,
          organizationId: "55555555-5555-4555-8555-555555555555",
        }),
      },
    },
  } as unknown as ProviderContext;
  await readWidgetOutreachHealth(otherOrganization, { campaignId });
  assert.equal(groupWalks, 2);
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

test("date windows require real dates and no more than 31 inclusive days", () => {
  assert.ok(
    widgetOutreachHealthInput.safeParse({ after: null, campaignId: null })
      .success
  );
  const valid = { campaignId, endDate: "2026-09-30", startDate: "2026-09-01" };
  assert.ok(widgetOutreachHealthInput.safeParse(valid).success);
  for (const input of [
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
          earlyFollowUps: null,
          endDate: "2026-09-30",
          lead: null,
          overview: null,
          sequenceStepDelays: null,
          startDate: "2026-09-01",
          statusHistory: [],
          stepSends: [],
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

test("per-step sends, first-touch counts and step delays are read only for the org-scoped selected campaign", () => {
  // Live 2026-10-05: a campaign sent only step 0 for two weeks and the widget
  // answered from one prospect thread because no tool returned step sends.
  const listed = buildWidgetOutreachHealthQuery(scope, {});
  for (const text of [
    "outreach_campaign_step_variant_metrics",
    "'sequences'",
  ]) {
    assert.equal(listed.includes(text), false, text);
  }
  const query = buildWidgetOutreachHealthQuery(scope, { campaignId });
  for (const required of [
    "from outreach_campaign_step_variant_metrics sv",
    "sv.organization_id = c.organization_id and sv.campaign_id = c.id",
    "sv.step ~ '^[0-9]{1,4}$'",
    'cm.new_leads_contacted_count as "newLeadsContacted"',
    "jsonb_typeof(c.settings->'sequences'->0->'steps') = 'array'",
    "join authorized a on a.id = c.organization_id",
  ]) {
    assert.ok(query.includes(required), required);
  }
});

test("step sends, first-touch counts and step delays round-trip through the output schema", () => {
  const diagnostics = {
    assignedInboxes: {
      accounts: [],
      configuredCount: null,
      healthyCount: 0,
      matchedCount: 0,
      nextAfterInboxId: null,
    },
    dailyMetrics: [
      {
        date: "2026-09-23",
        emailsBounced: 0,
        emailsDelivered: 109,
        emailsOpened: 0,
        emailsSent: 109,
        meetingsScheduled: 0,
        newLeadsContacted: 109,
        repliesReceived: 0,
        updatedAt: observedAt,
      },
    ],
    earlyFollowUps: null,
    endDate: "2026-09-30",
    lead: null,
    overview: null,
    sequenceStepDelays: [2, 2, 3],
    startDate: "2026-09-23",
    statusHistory: [],
    stepSends: [{ sent: 1003, snapshotAt: observedAt, step: 0 }],
  };
  const result = parseWidgetOutreachHealthEvidence(
    envelope([{ ...row, diagnostics }]),
    scope
  );
  assert.ok(widgetOutreachHealthOutput.safeParse(result).success);
  if (result.status !== "ok") {
    assert.fail("Expected saved diagnostics");
  }
  assert.deepEqual(result.campaigns[0].diagnostics, diagnostics);
  assert.ok(result.caveats.length <= 8);
  assert.ok(
    result.caveats.some((text) =>
      text.includes("no saved numeric-step evidence of follow-up sends")
    )
  );

  const list = parseWidgetOutreachHealthEvidence(envelope([row]), scope);
  if (list.status !== "ok") {
    assert.fail("Expected ok evidence");
  }
  assert.equal(list.campaigns[0].diagnostics, null);
});

test("a paused campaign carries its saved pause reason and dated status changes", () => {
  const query = buildWidgetOutreachHealthQuery(scope, { campaignId });
  for (const required of [
    'left(c.pause_reason, 300) as "pauseReason"',
    "from outreach_campaign_activity ca",
    "ca.organization_id = c.organization_id and ca.campaign_id = c.id",
    "ca.message like 'Campaign status updated to %'",
    "limit 10",
  ]) {
    assert.ok(query.includes(required), required);
  }
  const statusHistory = [
    {
      at: observedAt,
      message: "Campaign status updated to paused",
      status: "paused",
    },
  ];
  const result = parseWidgetOutreachHealthEvidence(
    envelope([
      {
        ...row,
        diagnostics: {
          assignedInboxes: {
            accounts: [],
            configuredCount: null,
            healthyCount: 0,
            matchedCount: 0,
            nextAfterInboxId: null,
          },
          dailyMetrics: [],
          earlyFollowUps: null,
          endDate: "2026-09-30",
          lead: null,
          overview: null,
          sequenceStepDelays: null,
          startDate: "2026-09-24",
          statusHistory,
          stepSends: [],
        },
        pauseReason: "Accounts unhealthy",
        status: "paused",
      },
    ]),
    scope
  );
  assert.ok(widgetOutreachHealthOutput.safeParse(result).success);
  if (result.status !== "ok") {
    assert.fail("Expected saved evidence");
  }
  assert.equal(result.campaigns[0].pauseReason, "Accounts unhealthy");
  assert.deepEqual(
    result.campaigns[0].diagnostics?.statusHistory,
    statusHistory
  );
});

test("a lead's own history is read only inside the selected owned campaign, without email text", () => {
  assert.equal(
    widgetOutreachHealthInput.safeParse({ leadEmail: "lead@example.test" })
      .success,
    false
  );
  const query = buildWidgetOutreachHealthQuery(scope, {
    campaignId,
    leadEmail: "O'Neil@Example.test",
  });
  for (const required of [
    "from outreach_webhook_event e",
    "e.organization_id = c.organization_id and e.provider_id = c.provider_id",
    "e.provider_campaign_id = c.provider_campaign_id",
    "array['O''Neil@Example.test', lower('O''Neil@Example.test')]",
    "cl.organization_id = c.organization_id and cl.campaign_id = c.id",
    "e.payload->>'email_account'",
    "limit 25",
  ]) {
    assert.ok(query.includes(required), required);
  }
  for (const forbidden of [
    "email_text",
    "reply_text",
    "email_html",
    "unibox_url",
    "email_subject",
  ]) {
    assert.equal(query.includes(forbidden), false, forbidden);
  }
  assert.equal(
    buildWidgetOutreachHealthQuery(scope, { campaignId }).includes(
      "e.lead_email = any("
    ),
    false
  );
  const lead = {
    bounceCount: 0,
    email: "lead@example.test",
    events: [
      {
        at: observedAt,
        eventType: "email_sent",
        sendingInbox: "jane@sender.example.test",
        step: 2,
        variant: 0,
      },
    ],
    inCampaign: true,
    openCount: 1,
    pushedToProvider: true,
    status: "contacted",
    statusAt: observedAt,
  };
  const result = parseWidgetOutreachHealthEvidence(
    envelope([
      {
        ...row,
        diagnostics: {
          assignedInboxes: {
            accounts: [],
            configuredCount: null,
            healthyCount: 0,
            matchedCount: 0,
            nextAfterInboxId: null,
          },
          dailyMetrics: [],
          earlyFollowUps: null,
          endDate: "2026-09-30",
          lead,
          overview: null,
          sequenceStepDelays: null,
          startDate: "2026-09-24",
          statusHistory: [],
          stepSends: [],
        },
      },
    ]),
    scope
  );
  assert.ok(widgetOutreachHealthOutput.safeParse(result).success);
  if (result.status !== "ok") {
    assert.fail("Expected saved evidence");
  }
  assert.deepEqual(result.campaigns[0].diagnostics?.lead, lead);
});

test("early follow-ups are found across the selected campaign's leads without a lead email", () => {
  // Live wrun_41M4C65K460GV34YR42A4W6NAN: follow-ups went out three hours after
  // the first email on a 3-day delay, and the widget asked the customer for a
  // lead email because only one named lead's history was readable.
  assert.equal(
    buildWidgetOutreachHealthQuery(scope, {}).includes(
      "outreach_webhook_event"
    ),
    false
  );
  const query = buildWidgetOutreachHealthQuery(scope, {
    campaignId,
    endDate: "2026-10-07",
    startDate: "2026-10-07",
  });
  for (const required of [
    "e.organization_id = c.organization_id and e.provider_id = c.provider_id",
    "e.provider_campaign_id = c.provider_campaign_id and e.event_type = 'email_sent'",
    "e.created_at < ('2026-10-07'::date) + 1",
    "s.at >= ('2026-10-07'::date)",
    "p.step = s.step - 1 and p.at <= s.at",
    "from s join d on d.step = s.step",
    'f.at - f."previousAt" < make_interval(days => f.delay)',
    "limit 10",
    "join authorized a on a.id = c.organization_id",
  ]) {
    assert.ok(query.includes(required), required);
  }
  for (const forbidden of [
    "email_text",
    "reply_text",
    "email_html",
    "unibox_url",
  ]) {
    assert.equal(query.includes(forbidden), false, forbidden);
  }
  const earlyFollowUps = {
    earlyCount: 221,
    earlyLeads: 221,
    examples: [
      {
        at: "2026-10-07T15:08:00.000Z",
        configuredDelayDays: 3,
        leadEmail: "lead@example.test",
        previousAt: "2026-10-07T12:00:00.000Z",
        sendingInbox: "jane@sender.example.test",
        step: 2,
      },
    ],
    followUpsChecked: 221,
    sameDayCount: 221,
    withoutPreviousSend: 0,
  };
  const result = parseWidgetOutreachHealthEvidence(
    envelope([
      {
        ...row,
        diagnostics: {
          assignedInboxes: {
            accounts: [],
            configuredCount: null,
            healthyCount: 0,
            matchedCount: 0,
            nextAfterInboxId: null,
          },
          dailyMetrics: [],
          earlyFollowUps,
          endDate: "2026-10-07",
          lead: null,
          overview: null,
          sequenceStepDelays: [0, 3, 3],
          startDate: "2026-10-07",
          statusHistory: [],
          stepSends: [],
        },
        // wrun ...4W6NAN: the campaign row was updated after the early sends.
        updatedAt: "2026-10-13T00:00:00.000Z",
      },
    ]),
    scope
  );
  assert.ok(widgetOutreachHealthOutput.safeParse(result).success);
  if (result.status !== "ok") {
    assert.fail("Expected saved evidence");
  }
  // Same day against a 3-day delay is the product sending early, marked as a
  // fault however recently the campaign row was updated (routine syncs move it).
  assert.deepEqual(result.campaigns[0].diagnostics?.earlyFollowUps, {
    ...earlyFollowUps,
    platformFault: true,
    reading:
      "221 follow-ups went out sooner than the campaign's configured delay, 221 of them within 24 hours of the email before them, although that step's delay is set to 3 days. A sending schedule can move a send by hours, not by days, so the product sent these follow-ups early: a platform fault for the team, not something the customer set up wrong.",
  });
  assert.ok(result.caveats.some((text) => text.includes("sameDayCount")));
  // A few hours short of a 1-day delay can be the schedule; none found is no fault.
  for (const early of [
    {
      ...earlyFollowUps,
      examples: [{ ...earlyFollowUps.examples[0], configuredDelayDays: 1 }],
    },
    { ...earlyFollowUps, earlyCount: 0, examples: [], sameDayCount: 0 },
  ]) {
    assert.equal(readEarlyFollowUps(early), null);
  }
});

test("the listing reads each provisioned workspace's campaign list once and reads the rules for every campaign", async (t) => {
  // wrun_41M48DWE6T0GW384F9JHWV4AYD never selected the campaign, so it never saw the rules.
  const second = "55555555-5555-4555-8555-555555555555";
  const created = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const call = t.mock.method(
    executorTransport,
    "call",
    (_wire: unknown, path: string) => {
      if (path.includes("planetscale")) {
        return {
          data: envelope([
            row,
            {
              ...row,
              createdAt: created,
              id: second,
              leadsNotPushedCount: 0,
              providerCampaignId: second,
              recentSends: [
                { date: "2026-09-17", emailsSent: 117, newLeadsContacted: 117 },
                { date: "2026-09-16", emailsSent: 0 },
              ],
            },
          ]),
          ok: true,
        };
      }
      if (path.includes("workspaceGroupMembers")) {
        return { data: { items: [member()] }, ok: true };
      }
      return {
        data: {
          items: [
            {
              daily_max_leads: 40,
              id: campaignId,
              prioritize_new_leads: true,
              status: 1,
            },
            {
              daily_max_leads: 120,
              id: second,
              prioritize_new_leads: true,
              status: 1,
            },
          ],
        },
        ok: true,
      };
    }
  );
  const result = await readWidgetOutreachHealth(ctx, {
    endDate: "2026-09-17",
    startDate: "2026-09-11",
  });
  assert.equal(call.mock.callCount(), 3);
  if (result.status !== "ok") {
    assert.fail("Expected saved evidence");
  }
  const readings = result.campaigns.map((campaign) =>
    campaign.live.available ? campaign.live.sendingRules.reading : "missing"
  );
  assert.match(String(readings[0]), WAITING_LEADS);
  assert.equal(
    readings[1],
    "This campaign is new and its first emails are at or near its cap of 120 new leads a day, so that daily new-lead cap is what limits first emails."
  );
  assert.ok(!JSON.stringify(result).includes("Instantly"));
});

test("a campaign created under a day ago with no sends gets the start-up reading with its real numbers", () => {
  // wrun_41M49GFMPB0GZ0VZ2R080H5YQP: saved about 12 minutes before the message, nothing sent.
  const now = Date.parse(observedAt);
  const fresh = {
    ...row,
    createdAt: new Date(now - 12 * 60_000).toISOString(),
    leadsNotPushedCount: 0,
    recentSends: [],
  };
  const rules = { maxNewLeadsPerDay: 117, newLeadsFirst: true };
  assert.equal(
    readSendingRules(rules, fresh, now),
    `This campaign was created on ${fresh.createdAt.slice(0, 10)} at ${fresh.createdAt.slice(11, 16)} UTC, less than a day before the customer's message, and has no sends yet. First emails go out only inside its sending schedule from 09:00 to 17:00 Etc/GMT+12 time on monday, tuesday, wednesday, thursday, friday, and at most 117 new leads get a first email each day. A brand-new campaign can take a while to start sending. New leads come first, so follow-ups wait until new leads have had their first email. This is the likely reason nothing has gone out yet, not a certainty.`
  );
  assert.equal(
    readSendingRules(
      rules,
      { ...fresh, recentSends: [{ date: "2026-09-17", emailsSent: 3 }] },
      now
    ),
    null
  );
  assert.equal(
    readSendingRules(
      rules,
      { ...fresh, createdAt: new Date(now - 2 * 86_400_000).toISOString() },
      now
    ),
    null
  );
});

test("a live re-run reads a campaign saved minutes before the message as new, and states the sends recorded since", async (t) => {
  // wrun_41M49GFMPB0GZ0VZ2R080H5YQP: that day's row now holds 196 sends made after the message.
  const asOf = "2026-10-06T21:03:58.775Z";
  t.mock.method(executorTransport, "call", (_wire: unknown, path: string) => {
    if (path.includes("planetscale")) {
      return {
        data: envelope([
          {
            ...row,
            createdAt: "2026-10-06T20:51:00.000Z",
            leadsNotPushedCount: 0,
            recentSends: [{ date: "2026-10-06", emailsSent: 196 }],
          },
        ]),
        ok: true,
      };
    }
    if (path.includes("workspaceGroupMembers")) {
      return { data: { items: [member()] }, ok: true };
    }
    return {
      data: {
        items: [
          {
            daily_max_leads: 117,
            id: campaignId,
            prioritize_new_leads: true,
            status: 1,
          },
        ],
      },
      ok: true,
    };
  });
  const replay = {
    ...ctx,
    session: {
      auth: {
        current: null,
        initiator: widgetAuth({ ...scope, liveAsOf: asOf }),
      },
    },
  } as unknown as ProviderContext;
  const result = await readWidgetOutreachHealth(replay, {
    endDate: "2026-10-06",
    startDate: "2026-09-30",
  });
  if (result.status !== "ok" || !result.campaigns[0]?.live.available) {
    assert.fail("Expected a live campaign");
  }
  // It was new at the message, but the sends recorded since then are stated, never "no sends yet".
  assert.equal(
    result.campaigns[0].live.sendingRules.reading,
    "This campaign was created on 2026-10-06 at 20:51 UTC, less than a day before the customer's message, and had no sends before it. Sends recorded since then show it has started sending (emails sent: 196 on 2026-10-06). First emails go out only inside its sending schedule from 09:00 to 17:00 Etc/GMT+12 time on monday, tuesday, wednesday, thursday, friday, and at most 117 new leads get a first email each day. New leads come first, so follow-ups wait until new leads have had their first email. So it was new rather than stuck when the customer wrote."
  );
  assert.deepEqual(result.campaigns[0].recentSends, [
    { date: "2026-10-06", emailsSent: 196 },
  ]);
});

test("a first-email cap reading uses first touches on the same day, not total emails", () => {
  const rules = { maxNewLeadsPerDay: 100, newLeadsFirst: false };
  const campaign = {
    ...row,
    createdAt: "2026-10-12T00:00:00Z",
    leadsNotPushedCount: 0,
    recentSends: [{ date: "2026-10-12", emailsSent: 300 }],
  };
  const now = Date.parse("2026-10-13T00:00:00Z");
  assert.equal(readSendingRules(rules, campaign, now), null);
  assert.equal(
    readSendingRules(
      rules,
      {
        ...campaign,
        recentSends: [{ ...campaign.recentSends[0], newLeadsContacted: 0 }],
      },
      now
    ),
    null
  );
  assert.ok(
    readSendingRules(
      rules,
      {
        ...campaign,
        recentSends: [{ ...campaign.recentSends[0], newLeadsContacted: 100 }],
      },
      now
    )?.includes("first emails are at or near its cap")
  );
  assert.ok(
    buildWidgetOutreachHealthQuery(scope, {}).includes(
      'cm.new_leads_contacted_count as "newLeadsContacted"'
    )
  );
});
