import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ProviderContext } from "#lib/executor/dispatch.js";
import { executorTransport } from "#lib/executor/transport.js";
import { verifiedFinContext } from "#lib/fin-investigation.fixture.js";
import { finInvestigationAuth } from "#lib/fin-investigation-auth.js";
import { verifiedWidgetContext } from "#lib/widget.fixture.js";
import { widgetAuth } from "#lib/widget-scope.js";
import definition, {
  readWidgetJobFailures,
  widgetJobFailuresInput,
  widgetJobFailuresOutput,
} from "./widget_job_failures.js";

const RATE_LIMITED_RE = /rate limited/;
const STALLED_RE = /stalled/;
const ID_MARKER_RE = /\[id\]/;

const scope = verifiedWidgetContext;
const originalConnector = process.env.EXECUTOR_MCP_CONNECTOR;
const originalBindings = process.env.EXECUTOR_OPERATION_BINDINGS;
process.env.EXECUTOR_MCP_CONNECTOR = "executor.test/widget";
process.env.EXECUTOR_OPERATION_BINDINGS = JSON.stringify({
  "inngest.apps": {
    path: "foreman_inngest_api.org.foremanInngestApi.apps.listApps",
  },
  "inngest.functionRuns": {
    path: "foreman_inngest_api.org.foremanInngestApi.apps.listFunctionRuns",
  },
  "inngest.runs": {
    path: "foreman_inngest_api.org.foremanInngestApi.runs.listRuns",
  },
  "inngest.trace": {
    path: "foreman_inngest_api.org.foremanInngestApi.runs.getRunTrace",
  },
});
const RUNS_PATH = "foreman_inngest_api.org.foremanInngestApi.runs.listRuns";
const TRACE_PATH = "foreman_inngest_api.org.foremanInngestApi.runs.getRunTrace";
const APPS_PATH = "foreman_inngest_api.org.foremanInngestApi.apps.listApps";
const FUNCTION_RUNS_PATH =
  "foreman_inngest_api.org.foremanInngestApi.apps.listFunctionRuns";
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

const ctx = {
  abortSignal: new AbortController().signal,
  getToken: async () => ({ token: "test-token" }),
  session: { auth: { current: null, initiator: widgetAuth(scope) } },
} as unknown as ProviderContext;

const someCampaignId = "44444444-4444-4444-8444-444444444444";
const someThreadId = "66666666-6666-4666-8666-666666666666";

const rawRun = (opts: {
  functionId: string;
  functionName: string;
  id: string;
  queuedAt: string;
  status: string;
}) => ({
  endedAt: null,
  function: { id: opts.functionId, name: opts.functionName },
  id: opts.id,
  queuedAt: opts.queuedAt,
  startedAt: opts.queuedAt,
  status: opts.status,
  trigger: { eventIds: [`evt-${opts.id}`] },
});
const runsBody = (rows: unknown[]) => ({
  data: rows,
  page: { hasMore: false },
});
const traceBody = (message: string) => ({
  data: {
    rootSpan: {
      children: [
        {
          endedAt: "2026-09-17T10:00:05Z",
          error: { message },
          name: "call-provider",
          startedAt: "2026-09-17T10:00:00Z",
          status: "FAILED",
        },
      ],
      name: "Run",
      status: "FAILED",
    },
  },
});

const campaignRun = rawRun({
  functionId: "campaign.dispatch.send",
  functionName: "Campaign Dispatch",
  id: "run-campaign",
  queuedAt: "2026-09-17T10:00:00Z",
  status: "FAILED",
});
const sdrRun = rawRun({
  functionId: "ai-sdr-v2.message-received",
  functionName: "AI SDR v2",
  id: "run-sdr",
  queuedAt: "2026-09-17T09:00:00Z",
  status: "FAILED",
});

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

test("input accepts only the area enum, never an org id or function selector", () => {
  for (const input of [
    { functionId: "campaign.dispatch.send" },
    { organizationId: scope.organizationId },
    { area: "not_a_real_area" },
    { area: "campaign_dispatch", extra: true },
  ]) {
    assert.equal(widgetJobFailuresInput.safeParse(input).success, false);
  }
  assert.ok(widgetJobFailuresInput.safeParse({}).success);
  assert.ok(widgetJobFailuresInput.safeParse({ area: "ai_sdr" }).success);
});

test("non-widget sessions are refused before any dispatch", async (t) => {
  t.mock.method(executorTransport, "call", () =>
    assert.fail("must not dispatch")
  );
  await assert.rejects(
    readWidgetJobFailures(
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

test("a matching failure surfaces its area, status and a redacted error, but no entity id", async (t) => {
  t.mock.method(
    executorTransport,
    "call",
    (_wire: unknown, path: string, input: Record<string, unknown>) => {
      if (path === RUNS_PATH) {
        return Promise.resolve({
          data: runsBody(input.status === "FAILED" ? [campaignRun] : []),
          ok: true,
        });
      }
      if (path === TRACE_PATH) {
        return Promise.resolve({
          data: traceBody(
            `Failed to dispatch campaign ${someCampaignId}: provider rate limited`
          ),
          ok: true,
        });
      }
      throw new Error(`unexpected transport call: ${path}`);
    }
  );
  const result = await readWidgetJobFailures(ctx, {});
  assert.ok(widgetJobFailuresOutput.safeParse(result).success);
  if (result.status !== "ok") {
    assert.fail("expected an ok result");
  }
  const finding = result.findingsByArea.campaign_dispatch;
  assert.ok(finding);
  assert.equal(finding.status, "failed");
  assert.match(finding.errorSummary, RATE_LIMITED_RE);
  assert.equal(finding.errorSummary.includes(someCampaignId), false);
  assert.match(finding.errorSummary, ID_MARKER_RE);
  assert.equal(JSON.stringify(result).includes(someCampaignId), false);
  assert.equal(result.findingsByArea.ai_sdr, null);
});

test("Inngest being unreachable is unavailable, never an empty ok result", async (t) => {
  t.mock.method(executorTransport, "call", () =>
    Promise.resolve({ error: { message: "upstream down" }, ok: false })
  );
  const warning = t.mock.method(console, "warn", () => undefined);
  const result = await readWidgetJobFailures(ctx, {});
  assert.equal(result.status, "unavailable");
  assert.equal(JSON.stringify(result).includes("upstream down"), false);
  assert.equal(warning.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(String(warning.mock.calls[0].arguments[0])), {
    code: "discovery",
    event: "widget.support.job_failures.failed",
    outcome: "error",
    tool: "widget_job_failures",
  });
});

test("no matching run in the window is a real empty result, distinct from unavailable", async (t) => {
  t.mock.method(executorTransport, "call", () =>
    Promise.resolve({ data: runsBody([]), ok: true })
  );
  const result = await readWidgetJobFailures(ctx, {});
  if (result.status !== "ok") {
    assert.fail("expected an ok result");
  }
  for (const area of Object.keys(result.findingsByArea)) {
    assert.equal(
      result.findingsByArea[area as keyof typeof result.findingsByArea],
      null
    );
  }
});

test("an area-scoped request fans out to that function's own recent history", async (t) => {
  t.mock.method(
    executorTransport,
    "call",
    (_wire: unknown, path: string, input: Record<string, unknown>) => {
      if (path === RUNS_PATH) {
        return Promise.resolve({
          data: runsBody(
            input.status === "FAILED" ? [campaignRun, sdrRun] : []
          ),
          ok: true,
        });
      }
      if (path === APPS_PATH) {
        return Promise.resolve({ data: { data: [{ id: "app-1" }] }, ok: true });
      }
      if (path === FUNCTION_RUNS_PATH) {
        return Promise.resolve({ data: runsBody([sdrRun]), ok: true });
      }
      if (path === TRACE_PATH) {
        return Promise.resolve({
          data:
            input.runId === "run-sdr"
              ? traceBody(
                  `AI SDR thread ${someThreadId} stalled: no calendar slot`
                )
              : traceBody(
                  `Failed to dispatch campaign ${someCampaignId}: rate limited`
                ),
          ok: true,
        });
      }
      throw new Error(`unexpected transport call: ${path}`);
    }
  );
  const result = await readWidgetJobFailures(ctx, { area: "ai_sdr" });
  if (result.status !== "ok") {
    assert.fail("expected an ok result");
  }
  const finding = result.findingsByArea.ai_sdr;
  assert.ok(finding);
  assert.equal(finding.functionName, "AI SDR v2");
  assert.match(finding.errorSummary, STALLED_RE);
  assert.equal(result.findingsByArea.campaign_dispatch, null);
});
