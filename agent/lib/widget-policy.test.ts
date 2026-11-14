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
const query = posthogQuery(verifiedWidgetContext.userId, reportedAt);

test("the PostHog query reads only this user in the 30 minutes before the report", () => {
  assert.ok(query.includes(`distinct_id = '${verifiedWidgetContext.userId}'`));
  assert.ok(query.includes("toDateTime('2026-11-11T18:25:00.000Z')"));
  assert.ok(query.includes("toDateTime('2026-11-11T18:55:00.000Z')"));
  assert.ok(query.includes("properties.$pathname"));
  assert.ok(!query.includes("$current_url"));
  assert.throws(() => posthogQuery("x' OR 1=1 --", reportedAt));
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
      query: posthogQuery("99999999-9999-4999-8999-999999999999", reportedAt),
    },
    {
      query: posthogQuery(
        verifiedWidgetContext.userId,
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
