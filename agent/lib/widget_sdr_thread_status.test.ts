import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ProviderContext } from "#lib/executor/dispatch.js";
import { WIDGET_TOOLKIT } from "#lib/executor/endpoint.js";
import { executorTransport } from "#lib/executor/transport.js";
import { verifiedFinContext } from "#lib/fin-investigation.fixture.js";
import { finInvestigationAuth } from "#lib/fin-investigation-auth.js";
import { verifiedWidgetContext } from "#lib/widget.fixture.js";
import { widgetAuth } from "#lib/widget-scope.js";
import definition, {
  buildWidgetSdrQuery,
  parseWidgetSdrEvidence,
  readWidgetSdrThreadStatus,
  widgetSdrInput,
  widgetSdrOutput,
} from "../tools/widget_sdr_thread_status.js";

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

const threadId = "44444444-4444-4444-8444-444444444444";
const appointmentId = "55555555-5555-4555-8555-555555555555";
const observedAt = "2026-09-17T10:00:00.000Z";
const workspace = {
  aiSdrEnabled: true,
  aiSdrV2Enabled: true,
  hasSettings: true,
  host: {
    calendarAccounts: [{ failureCount: 0, invalid: false, type: "google" }],
    conferencingAccounts: [{ invalid: true, type: "zoom_video" }],
    conferencingLinkType: "dynamic",
    timezone: "America/Chicago",
    workHoursDays: ["monday", "tuesday"],
  },
};
const thread = {
  controlLevel: "automated",
  id: threadId,
  interestLevel: "high",
  isOutOfOffice: false,
  lastMessageAt: observedAt,
  lifecycle: "slots_sent",
  nextFollowupAt: observedAt,
  prospectTimezone: "Europe/Lisbon",
};
const detail = {
  ...thread,
  appointments: [
    {
      canceledAt: null,
      clientTimeZone: "Europe/Lisbon",
      durationInMinutes: 30,
      hasMeetingUrl: false,
      id: appointmentId,
      origin: "ai_sdr",
      rescheduleCount: 1,
      startAt: observedAt,
      status: "scheduled",
      supersededByAppointmentId: null,
    },
  ],
  followups: [
    {
      executedAt: null,
      scheduledAt: observedAt,
      sequenceIndex: 0,
      skipReason: null,
      status: "pending",
      totalInSequence: 3,
    },
  ],
  replySync: {
    replyEventsLast30d: 3,
    storedInboundLast30d: 2,
    storedInboundTotal: 2,
    unresolvedReplyEventsLast30d: 1,
  },
};
const envelope = (
  records: unknown[],
  options: { authorized?: boolean; workspace?: unknown } = {}
) => ({
  content: [
    {
      text: JSON.stringify({
        rows: [
          {
            authorized: options.authorized ?? true,
            observedAt,
            records,
            workspace:
              options.workspace === undefined ? workspace : options.workspace,
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

test("inputs accept only an owned thread id or cursor", () => {
  for (const input of [
    { organizationId: scope.organizationId },
    { query: "select * from member" },
    { threadId: "x' or true --" },
    { after: "x' or true --" },
    { after: threadId, threadId },
    { read: "threads" },
  ]) {
    assert.equal(widgetSdrInput.safeParse(input).success, false);
    assert.throws(() => buildWidgetSdrQuery(scope, input as never));
  }
  assert.ok(widgetSdrInput.safeParse({}).success);
  assert.ok(widgetSdrInput.safeParse({ threadId }).success);
  assert.ok(widgetSdrInput.safeParse({ after: threadId }).success);
});

test("every statement checks membership and scopes every product join to the organization", () => {
  for (const input of [{}, { after: threadId }, { threadId }]) {
    const query = buildWidgetSdrQuery(scope, input);
    for (const required of [
      scope.organizationId,
      scope.userId,
      "m.deleted_at is null",
      "o.deleted_at is null",
      "m.role in ('owner', 'admin')",
      "o.partner_id",
      "join authorized a on a.id = t.organization_id",
      "count(*) = 1",
      "t.deleted_at is null",
      "sf.organization_id = t.organization_id",
      "ap.organization_id = t.organization_id",
      "join authorized a2 on a2.handler_id = u.id",
    ]) {
      assert.ok(query.includes(required), required);
    }
    for (const forbidden of [
      "select *",
      "u.email",
      "u.name",
      "ap.attendees",
      "meeting_url as",
      "ca.key",
      "cf.key",
      "body_text",
      "payload",
    ]) {
      assert.equal(query.includes(forbidden), false, forbidden);
    }
  }
  const query = buildWidgetSdrQuery(scope, { threadId });
  assert.ok(query.includes("m.organization_id = t.organization_id"));
  assert.ok(query.includes("w.organization_id = t.organization_id"));
  assert.ok(query.includes(`t.id = '${threadId}'::uuid`));
  const paged = buildWidgetSdrQuery(scope, { after: threadId });
  assert.ok(paged.includes("join authorized a2 on a2.id = c.organization_id"));
});

test("dispatch sends the org-scoped query through the widget toolkit", async (t) => {
  const call = t.mock.method(executorTransport, "call", async () => ({
    data: envelope([detail]),
    ok: true,
  }));
  const result = await readWidgetSdrThreadStatus(ctx, { threadId });
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

test("thread detail output matches the schema and flags a reply-sync gap", () => {
  const result = parseWidgetSdrEvidence(envelope([detail]), scope, {
    threadId,
  });
  assert.ok(widgetSdrOutput.safeParse(result).success);
  assert.equal(result.status, "ok");
  if (result.status !== "ok" || result.evidence.read !== "thread") {
    assert.fail("Expected thread evidence");
  }
  assert.equal(result.evidence.possibleReplySyncGap, true);
  assert.equal(result.evidence.thread.lifecycle, "slots_sent");
  assert.equal(result.evidence.appointments[0].hasMeetingUrl, false);
  assert.equal(result.evidence.workspace.host?.timezone, "America/Chicago");
  assert.equal(result.workspace, scope.organizationName);
  const unknown = parseWidgetSdrEvidence(
    envelope([
      {
        ...detail,
        replySync: {
          ...detail.replySync,
          replyEventsLast30d: null,
          unresolvedReplyEventsLast30d: null,
        },
      },
    ]),
    scope,
    { threadId }
  );
  if (unknown.status !== "ok" || unknown.evidence.read !== "thread") {
    assert.fail("Expected thread evidence");
  }
  assert.equal(unknown.evidence.possibleReplySyncGap, null);
});

test("summary output paginates and matches the schema", () => {
  const rows = Array.from({ length: 26 }, (_, index) => ({
    ...thread,
    hasActiveAppointment: index % 2 === 0,
    hasPendingFollowup: false,
    id: `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
  }));
  const result = parseWidgetSdrEvidence(envelope(rows), scope, {});
  assert.ok(widgetSdrOutput.safeParse(result).success);
  if (result.status !== "ok" || result.evidence.read !== "threads") {
    assert.fail("Expected thread summary");
  }
  assert.equal(result.evidence.threads.length, 25);
  assert.equal(result.evidence.nextAfter, rows[24].id);
  assert.equal(result.evidence.workspace.hasSettings, true);
  const empty = parseWidgetSdrEvidence(envelope([]), scope, {});
  assert.equal(empty.status, "ok");
  if (empty.status === "ok" && empty.evidence.read === "threads") {
    assert.deepEqual(empty.evidence.threads, []);
    assert.equal(empty.evidence.nextAfter, null);
  }
});

test("empty, foreign, denied and unavailable stay distinct", async (t) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  assert.equal(
    parseWidgetSdrEvidence(envelope([]), scope, { threadId }).status,
    "not_available"
  );
  assert.equal(
    parseWidgetSdrEvidence(envelope([detail], { authorized: false }), scope, {
      threadId,
    }).status,
    "denied"
  );
  assert.equal(
    parseWidgetSdrEvidence(envelope([], { workspace: null }), scope, {}).status,
    "denied"
  );
  assert.throws(() =>
    parseWidgetSdrEvidence(
      envelope([{ ...detail, id: scope.organizationId }]),
      scope,
      { threadId }
    )
  );
  t.mock.method(executorTransport, "call", async () => ({
    error: { code: "oauth_reauth_required", message: "secret upstream detail" },
    ok: false,
  }));
  const failed = await readWidgetSdrThreadStatus(ctx, {});
  assert.equal(failed.status, "unavailable");
  assert.equal(JSON.stringify(failed).includes("secret"), false);
  assert.equal(warning.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(String(warning.mock.calls[0].arguments[0])), {
    code: "transport",
    event: "widget.support.sdr_thread_status.failed",
    outcome: "error",
    tool: "widget_sdr_thread_status",
  });
});

test("malformed rows become unavailable without leaking values, and extra fields are dropped", async (t) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  t.mock.method(executorTransport, "call", async () => ({
    data: envelope([{ ...detail, lifecycle: "secret provider value" }]),
    ok: true,
  }));
  const result = await readWidgetSdrThreadStatus(ctx, { threadId });
  assert.equal(result.status, "unavailable");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(
    JSON.parse(String(warning.mock.calls[0].arguments[0])).code,
    "response"
  );
  const extra = parseWidgetSdrEvidence(
    envelope([
      {
        ...detail,
        appointments: [
          {
            ...detail.appointments[0],
            attendees: "secret",
            meetingUrl: "secret",
          },
        ],
        prospectEmail: "secret",
      },
    ]),
    scope,
    { threadId }
  );
  assert.equal(extra.status, "ok");
  assert.equal(JSON.stringify(extra).includes("secret"), false);
});

test("non-widget sessions are refused before any dispatch", async (t) => {
  t.mock.method(executorTransport, "call", () =>
    assert.fail("must not dispatch")
  );
  await assert.rejects(
    readWidgetSdrThreadStatus(
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
