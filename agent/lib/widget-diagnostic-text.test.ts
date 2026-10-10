import assert from "node:assert/strict";
import { after, type TestContext, test } from "node:test";
import { executorTransport } from "#lib/executor/transport.js";
import { verifiedWidgetContext } from "#lib/widget.fixture.js";
import { widgetAuth } from "#lib/widget-scope.js";
import { readWidgetInboxHealth } from "../tools/widget_inbox_health.js";
import { parseWidgetOutreachHealthEvidence } from "../tools/widget_outreach_health.js";

const originalConnector = process.env.EXECUTOR_MCP_CONNECTOR;
const originalBindings = process.env.EXECUTOR_OPERATION_BINDINGS;
process.env.EXECUTOR_MCP_CONNECTOR = "executor.test/widget";
process.env.EXECUTOR_OPERATION_BINDINGS = JSON.stringify({
  "planetscale.readQuery": {
    path: "planetscale.org.foremanPlanetscale.planetscale_execute_read_query",
  },
});
after(() => {
  for (const [key, value] of [
    ["EXECUTOR_MCP_CONNECTOR", originalConnector],
    ["EXECUTOR_OPERATION_BINDINGS", originalBindings],
  ]) {
    if (value === undefined) {
      delete process.env[key as string];
    } else {
      process.env[key as string] = value;
    }
  }
});
const at = "2026-10-10T10:00:00.000Z";
const campaignId = "44444444-4444-4444-8444-444444444444";
const email = "instantly@own.example.test";
const envelope = (row: unknown) => ({
  content: [
    { text: JSON.stringify({ rows: [row], success: true }), type: "text" },
  ],
});

async function diagnostics(t: TestContext, text: string) {
  t.mock.method(executorTransport, "call", async () => ({
    data: envelope({
      accountErrors: [{ count: 1, email, lastAt: at }],
      accountType: "system_provisioned",
      authorized: true,
      connectionError: text,
      connectionUpdatedAt: at,
      hasConnectionError: true,
      initialWarmupEmails: [],
      isActive: false,
      lastWebhookEventAt: null,
      observedAt: at,
      recentWebhookErrorCount: 0,
      recentWebhookEventCount: 0,
      reconnectAttempts: [
        {
          completedAt: null,
          createdAt: at,
          email,
          error: text,
          status: "failed",
        },
      ],
      savedInboxes: {
        inboxes: [
          {
            connected: false,
            connectionError: text,
            email,
            firstName: "Instantly",
            lastName: "Zapmail",
            lastRetryAt: null,
            mailboxType: "dfy",
            retryCount: 0,
            status: "error",
          },
        ],
        total: 1,
      },
      webhookRegisteredCount: 0,
      workspaceId: null,
    }),
    ok: true,
  }));
  const inbox = await readWidgetInboxHealth({
    abortSignal: new AbortController().signal,
    getToken: async () => ({ token: "test-token" }),
    session: {
      auth: { current: null, initiator: widgetAuth(verifiedWidgetContext) },
    },
  } as never);
  const outreach = parseWidgetOutreachHealthEvidence(
    envelope({
      authorized: true,
      inboxes: { healthyAccounts: 0, totalSendingAccounts: 1 },
      observedAt: at,
      records: [
        {
          accountType: "system_provisioned",
          dailyLimit: null,
          days: null,
          diagnostics: {
            assignedInboxes: {
              accounts: [],
              configuredCount: null,
              healthyCount: 0,
              matchedCount: 0,
              nextAfterInboxId: null,
            },
            dailyMetrics: [],
            endDate: "2026-10-10",
            lead: null,
            overview: null,
            sequenceStepDelays: null,
            startDate: "2026-10-10",
            statusHistory: [
              {
                at,
                message: `Campaign launch failed: ${text}`,
                status: "paused",
              },
            ],
            stepSends: [],
          },
          fromTime: null,
          id: campaignId,
          leadsNotPushedCount: 0,
          name: "Instantly Zapmail",
          notSendingStatusRaw: null,
          pauseReason: text,
          provider: "instantly",
          providerCampaignId: campaignId,
          providerWorkspaceId: null,
          recentSends: [],
          status: "paused",
          timezone: null,
          toTime: null,
          totalLeads: 0,
          updatedAt: at,
        },
      ],
    }),
    verifiedWidgetContext
  );
  if (inbox.status !== "ok" || outreach.status !== "ok") {
    assert.fail("Expected diagnostic evidence");
  }
  assert.equal(inbox.savedInboxes.inboxes[0].firstName, "Instantly");
  assert.equal(inbox.savedInboxes.inboxes[0].lastName, "Zapmail");
  assert.equal(inbox.savedInboxes.inboxes[0].email, email);
  assert.equal(inbox.accountErrors[0].email, email);
  assert.equal(outreach.campaigns[0].name, "Instantly Zapmail");
  return [
    inbox.connection?.connectionError,
    inbox.savedInboxes.inboxes[0].connectionError,
    inbox.reconnectAttempts[0].error,
    outreach.campaigns[0].pauseReason,
    outreach.campaigns[0].diagnostics?.statusHistory[0].message,
  ];
}

test("diagnostic fields suppress credentials, URLs, HTML and exception traces", async (t) => {
  for (const text of [
    "OAuth failed: token=synthetic_probe_secret",
    'OAuth failed: {"password":"synthetic_probe_secret"}',
    "Authentication failed Bearer synthetic_probe_secret",
    "Connection failed https://provider.test/?token=synthetic_probe_secret",
    "TypeError: synthetic_probe_secret\n at provider.ts:10:2",
    "<html><body>synthetic_probe_secret</body></html>",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: each case replaces the shared transport mock
    const results = await diagnostics(t, text);
    for (const result of results) {
      assert.ok(result);
      assert.equal(result.includes("synthetic_probe_secret"), false, result);
      assert.equal(result.includes("https://"), false, result);
      assert.equal(result.includes("provider.ts"), false, result);
      assert.equal(result.includes("<html>"), false, result);
      assert.ok(result.length <= 200);
    }
  }
});

test("diagnostic fields neutralize vendors without rewriting customer names or addresses", async (t) => {
  for (const [text, expected] of [
    [
      "Disconnected via Instantly account_error webhook",
      "The sending provider reported an account error",
    ],
    [
      "The request was rejected by Instantly. Please verify your API key.",
      "The sending-account connection was rejected",
    ],
    [
      "Waiting on zapmail oauth connection",
      "Waiting for mailbox authorization",
    ],
    [
      "UnknownVendor connection failed",
      "A diagnostic was recorded; its technical details are unavailable",
    ],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: each case replaces the shared transport mock
    const results = await diagnostics(t, text);
    assert.deepEqual(results.slice(0, 4), new Array(4).fill(expected));
    assert.equal(results[4], `Campaign launch failed: ${expected}`);
  }
});
