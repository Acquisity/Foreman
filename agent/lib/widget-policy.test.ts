import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  invokeProvider,
  type ProviderContext,
} from "#lib/executor/dispatch.js";
import { executorTransport } from "#lib/executor/transport.js";
import { verifiedWidgetContext } from "#lib/widget.fixture.js";
import {
  assertWidgetPath,
  INNGEST_READ,
  inngestRunsInput,
  POSTHOG_READ,
  posthogQuery,
} from "#lib/widget-policy.js";
import { widgetAuth } from "#lib/widget-scope.js";

const originalConnector = process.env.EXECUTOR_MCP_CONNECTOR_SUPPORT;
process.env.EXECUTOR_MCP_CONNECTOR_SUPPORT = "executor.test/widget";
after(() => {
  if (originalConnector === undefined) {
    delete process.env.EXECUTOR_MCP_CONNECTOR_SUPPORT;
  } else {
    process.env.EXECUTOR_MCP_CONNECTOR_SUPPORT = originalConnector;
  }
});

const OWN_ACTIVITY = /own activity/;
const OWN_RUNS = /own runs/;
const OUTSIDE = /outside the support widget toolkit/;
const reportedAt = new Date("2026-11-11T18:55:00.000Z");
const reported = {
  ...verifiedWidgetContext,
  bugReportedAt: reportedAt.toISOString(),
};
const context = (scope: typeof verifiedWidgetContext) =>
  ({
    abortSignal: new AbortController().signal,
    getToken: () => Promise.resolve({ token: "test-token" }),
    session: { auth: { current: null, initiator: widgetAuth(scope) } },
  }) as unknown as ProviderContext;
const query = posthogQuery(
  verifiedWidgetContext.userId,
  verifiedWidgetContext.organizationId,
  reportedAt
);
const OTHER = "99999999-9999-4999-8999-999999999999";

test("the PostHog query reads only this user in this workspace in the 30 minutes before the report", () => {
  assert.ok(query.includes(`distinct_id = '${verifiedWidgetContext.userId}'`));
  assert.ok(query.includes("toDateTime('2026-11-11T18:25:00.000Z')"));
  assert.ok(query.includes("toDateTime('2026-11-11T18:55:00.000Z')"));
  assert.ok(query.includes("properties.$pathname"));
  assert.ok(!query.includes("$current_url"));
  assert.ok(
    query.includes(`AND $group_0 = '${verifiedWidgetContext.organizationId}'`)
  );
  assert.throws(() =>
    posthogQuery(
      "x' OR 1=1 --",
      verifiedWidgetContext.organizationId,
      reportedAt
    )
  );
  assert.throws(() =>
    posthogQuery(verifiedWidgetContext.userId, "x' OR 1=1 --", reportedAt)
  );
});

test("the policy allows only the exact query built for this user and report", async (t) => {
  const call = t.mock.method(executorTransport, "call", async () => ({
    data: {
      content: [{ text: "timestamp|event|errorCode|$pathname", type: "text" }],
    },
    ok: true,
  }));
  await invokeProvider(context(reported), POSTHOG_READ.path, { query });
  assert.equal(call.mock.callCount(), 1);
  const refused = [
    {
      query: posthogQuery(
        OTHER,
        verifiedWidgetContext.organizationId,
        reportedAt
      ),
    },
    {
      query: posthogQuery(verifiedWidgetContext.userId, OTHER, reportedAt),
    },
    {
      query: posthogQuery(
        verifiedWidgetContext.userId,
        verifiedWidgetContext.organizationId,
        new Date("2026-11-10T18:55:00.000Z")
      ),
    },
    { connectionId: "warehouse", query },
    { query, sendRawQuery: true },
    { query: "SELECT * FROM events" },
  ];
  await Promise.all(
    refused.map((input) =>
      assert.rejects(
        invokeProvider(context(reported), POSTHOG_READ.path, input),
        OWN_ACTIVITY
      )
    )
  );
  // A session the bug report did not stamp, such as a model investigation, reaches nothing.
  await assert.rejects(
    invokeProvider(context(verifiedWidgetContext), POSTHOG_READ.path, {
      query,
    }),
    OWN_ACTIVITY
  );
  assert.equal(call.mock.callCount(), 1);
  assert.throws(() => assertWidgetPath(POSTHOG_READ.path), OUTSIDE);
});

test("the PostHog query replaces error-code pipes before the path column", () => {
  assert.ok(
    query.includes(
      "replaceAll(toString(properties.errorCode), '|', ' ') AS errorCode"
    )
  );
});

test("the PostHog query marks each row's session as recorded or not, matched by session id", () => {
  assert.ok(query.includes("toString(properties.$session_id) AS sessionId"));
  assert.ok(
    query.includes(
      "sessionId IN (SELECT session_id FROM raw_session_replay_events WHERE min_first_timestamp <= toDateTime('2026-11-11T18:55:00.000Z') AND max_last_timestamp >= toDateTime('2026-11-11T18:25:00.000Z'))"
    )
  );
  // A session that also shows another workspace that day is never linked.
  assert.ok(
    query.includes(
      `AND sessionId NOT IN (SELECT toString(properties.$session_id) FROM events WHERE distinct_id = '${verifiedWidgetContext.userId}' AND $group_0 != '' AND $group_0 != '${verifiedWidgetContext.organizationId}' AND timestamp >= toDateTime('2026-11-10T18:55:00.000Z') AND timestamp <= toDateTime('2026-11-11T18:55:00.000Z')) AS recorded`
    )
  );
  assert.ok(query.endsWith("LIMIT 8"));
});

test("the Inngest read is this workspace's failed runs in the hour before the report", () => {
  assert.deepEqual(
    inngestRunsInput(verifiedWidgetContext.organizationId, reportedAt),
    {
      env: "production",
      from: "2026-11-11T17:55:00.000Z",
      limit: 8,
      query: `event.data.organizationId == "${verifiedWidgetContext.organizationId}"`,
      status: ["FAILED"],
      until: "2026-11-11T18:55:00.000Z",
    }
  );
  assert.throws(() => inngestRunsInput('x" || true || "', reportedAt));
});

test("the policy allows only the fixed Inngest input for this workspace and report, with or without a cursor", async (t) => {
  const call = t.mock.method(executorTransport, "call", async () => ({
    data: { content: [], structuredContent: { page: { limit: 8 } } },
    ok: true,
  }));
  const own = inngestRunsInput(
    verifiedWidgetContext.organizationId,
    reportedAt
  );
  await invokeProvider(context(reported), INNGEST_READ.path, own);
  await invokeProvider(context(reported), INNGEST_READ.path, {
    ...own,
    cursor: "next-page",
  });
  assert.equal(call.mock.callCount(), 2);
  const { query: _query, ...unfiltered } = own;
  const refused = [
    unfiltered,
    inngestRunsInput("99999999-9999-4999-8999-999999999999", reportedAt),
    inngestRunsInput(
      verifiedWidgetContext.organizationId,
      new Date("2026-11-10T18:55:00.000Z")
    ),
    { ...own, status: ["COMPLETED", "FAILED"] },
    { ...own, limit: 100 },
    { ...own, cursor: 1 },
    { ...own, appId: ["ai-clients"] },
  ];
  await Promise.all(
    refused.map((input) =>
      assert.rejects(
        invokeProvider(context(reported), INNGEST_READ.path, input),
        OWN_RUNS
      )
    )
  );
  // A session the bug report did not stamp, such as a model investigation, reaches nothing.
  await assert.rejects(
    invokeProvider(context(verifiedWidgetContext), INNGEST_READ.path, own),
    OWN_RUNS
  );
  assert.equal(call.mock.callCount(), 2);
  assert.throws(() => assertWidgetPath(INNGEST_READ.path), OUTSIDE);
});
