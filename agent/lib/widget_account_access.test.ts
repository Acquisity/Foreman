import assert from "node:assert/strict";
import { after, type TestContext, test } from "node:test";
import type { ProviderContext } from "#lib/executor/dispatch.js";
import { WIDGET_TOOLKIT } from "#lib/executor/endpoint.js";
import { executorTransport } from "#lib/executor/transport.js";
import { verifiedFinContext } from "#lib/fin-investigation.fixture.js";
import { finInvestigationAuth } from "#lib/fin-investigation-auth.js";
import { verifiedWidgetContext } from "#lib/widget.fixture.js";
import { widgetAuth } from "#lib/widget-scope.js";
import definition, {
  buildAccountAccessQuery,
  parseAccountAccess,
  parseSentryUserErrors,
  readWidgetAccountAccess,
  widgetAccountAccessInput,
  widgetAccountAccessOutput,
} from "../tools/widget_account_access.js";

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

const observedAt = "2026-09-17T10:00:00.000Z";
const unavailableErrors = {
  reason: "sentry_unconfigured" as const,
  status: "unavailable" as const,
};
const row = {
  account: {
    banExpiresAt: null,
    banned: false,
    banReason: null,
    emailVerified: true,
    lastLoginAt: observedAt,
    onboardingCallScheduled: false,
    onboardingComplete: true,
    onboardingCompletedAt: observedAt,
    twoFactorEnabled: true,
  },
  authorized: true,
  invitations: [
    {
      createdAt: observedAt,
      email: "invitee@example.com",
      expired: false,
      expiresAt: "2026-09-24T10:00:00.000Z",
      role: "member",
      status: "pending",
    },
  ],
  membership: { memberSince: observedAt, role: "owner" },
  observedAt,
  onboarding: {
    businessInfo: true,
    coldEmail: false,
    flowType: "full",
    goals: true,
    icp: false,
    lead: false,
    niche: false,
    offer: false,
    personalInfo: true,
    updatedAt: observedAt,
  },
  organization: {
    name: "Aaron Fraga's Workspace",
    onboardingStatus: "pending",
    partnerManaged: false,
    slug: scope.organizationSlug,
  },
  seats: [
    { count: 2, role: "admin" },
    { count: 3, role: "member" },
    { count: 1, role: "owner" },
  ],
};
const envelope = (record: Record<string, unknown> = row) => ({
  content: [
    { text: JSON.stringify({ rows: [record], success: true }), type: "text" },
  ],
});
const sentryEnvelope = (issues: unknown[]) => ({
  content: [{ text: JSON.stringify({ issues }), type: "text" }],
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

test("input accepts nothing but an empty object", () => {
  assert.ok(widgetAccountAccessInput.safeParse({}).success);
  for (const input of [
    { organizationId: scope.organizationId },
    { userId: scope.userId },
    { query: "select * from member" },
    { read: "account" },
  ]) {
    assert.equal(widgetAccountAccessInput.safeParse(input).success, false);
  }
});

test("the statement re-checks membership and scopes every read to the verified user and org", () => {
  const query = buildAccountAccessQuery(scope);
  for (const required of [
    `o.id = '${scope.organizationId}'::uuid`,
    `m.user_id = '${scope.userId}'::uuid`,
    `u.id = '${scope.userId}'::uuid`,
    `os.user_id = '${scope.userId}'::uuid`,
    "o.deleted_at is null",
    "m.deleted_at is null",
    "m.role in ('owner', 'admin')",
    "o.partner_id",
    "join authorized a on a.id = os.organization_id",
    "join authorized a on a.id = mm.organization_id",
    "join authorized a on a.id = inv.organization_id",
    "count(*) = 1",
    "inv.status = 'pending'",
  ]) {
    assert.ok(query.includes(required), required);
  }
});

test("the statement selects no password, session, token or other member email", () => {
  const query = buildAccountAccessQuery(scope).toLowerCase();
  for (const forbidden of [
    "select *",
    "password",
    "hash",
    "session_token",
    "access_token",
    "refresh_token",
    " from session",
    "two_factor_secret",
    "personal_info_form_data as",
    "u.name",
    "u.email as",
    "u.email,",
    "mm.user_id",
    "inv.inviter_id",
  ]) {
    assert.equal(query.includes(forbidden), false, forbidden);
  }
  // Only pending invitations expose an invited email; no other member email column is read.
  assert.equal(query.includes("mm.email"), false);
});

test("account access output matches the schema and carries no sensitive field", () => {
  const result = parseAccountAccess(envelope(), scope, unavailableErrors);
  assert.ok(widgetAccountAccessOutput.safeParse(result).success);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    assert.fail("Expected ok");
  }
  assert.equal(result.membership.role, "owner");
  assert.equal(result.account.twoFactorEnabled, true);
  assert.equal(result.onboarding?.personalInfo, true);
  assert.equal(result.onboarding?.icp, false);
  assert.equal(result.seats.used, 6);
  assert.equal(result.seats.planLimit, null);
  assert.equal(result.pendingInvitations[0].email, "invitee@example.com");
  assert.equal(result.userErrorSignals.status, "unavailable");
  assert.equal(result.workspace, scope.organizationName);
  const serialized = JSON.stringify(result).toLowerCase();
  for (const forbidden of [
    "password",
    "hash",
    '"session"',
    '"token"',
    "form_data",
    "secret",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("onboarding may be absent without collapsing to denied", () => {
  const result = parseAccountAccess(
    envelope({ ...row, onboarding: null }),
    scope,
    unavailableErrors
  );
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.onboarding, null);
  }
});

test("missing authorization or scope rows read as denied, never empty", () => {
  assert.equal(
    parseAccountAccess(
      envelope({ ...row, authorized: false }),
      scope,
      unavailableErrors
    ).status,
    "denied"
  );
  assert.equal(
    parseAccountAccess(
      envelope({ ...row, organization: null }),
      scope,
      unavailableErrors
    ).status,
    "denied"
  );
  assert.equal(
    parseAccountAccess(
      envelope({ ...row, membership: null }),
      scope,
      unavailableErrors
    ).status,
    "denied"
  );
});

test("dispatch sends the org-scoped query through the widget toolkit", async (t) => {
  const call = t.mock.method(executorTransport, "call", async () => ({
    data: envelope(),
    ok: true,
  }));
  const result = await readWidgetAccountAccess(ctx);
  assert.equal(result.status, "ok");
  // Sentry is unbound in this env, so only the one product read dispatches.
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
  assert.ok(input.query.includes(scope.userId));
  assert.equal(input.use_replica, false);
  if (result.status === "ok") {
    assert.equal(result.userErrorSignals.status, "unavailable");
  }
});

test("a provider failure reads as unavailable without leaking upstream detail", async (t) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  t.mock.method(executorTransport, "call", async () => ({
    error: { code: "oauth_reauth_required", message: "secret upstream detail" },
    ok: false,
  }));
  const failed = await readWidgetAccountAccess(ctx);
  assert.equal(failed.status, "unavailable");
  assert.equal(JSON.stringify(failed).includes("secret"), false);
  assert.equal(JSON.stringify(failed).includes("oauth"), false);
  assert.equal(warning.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(String(warning.mock.calls[0].arguments[0])), {
    code: "transport",
    event: "widget.support.account_access.failed",
    outcome: "error",
    tool: "widget_account_access",
  });
});

test("malformed rows become unavailable without leaking values", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(executorTransport, "call", async () => ({
    data: envelope({ ...row, seats: "not-an-array" }),
    ok: true,
  }));
  const result = await readWidgetAccountAccess(ctx);
  assert.equal(result.status, "unavailable");
  assert.equal(JSON.stringify(result).includes("not-an-array"), false);
});

test("Sentry signals aggregate to sanitized counts, and any unexpected shape reads malformed", () => {
  const ok = parseSentryUserErrors(
    sentryEnvelope([
      {
        count: "4",
        lastSeen: "2026-09-16T09:00:00.000Z",
        metadata: { type: "InvalidSessionError", value: "leaked value" },
        title: "InvalidSessionError: token expired",
      },
      {
        count: 2,
        lastSeen: "2026-09-17T09:00:00.000Z",
        type: "LoginError",
      },
    ])
  );
  assert.equal(ok.status, "ok");
  if (ok.status === "ok") {
    assert.equal(ok.total, 6);
    assert.equal(ok.lastSeenAt, "2026-09-17T09:00:00.000Z");
    assert.deepEqual(ok.classes, ["InvalidSessionError", "LoginError"]);
    // Sanitized classes only; raw messages and metadata values never surface.
    assert.equal(JSON.stringify(ok).includes("leaked value"), false);
    assert.equal(JSON.stringify(ok).includes("token expired"), false);
  }
  const empty = parseSentryUserErrors(sentryEnvelope([]));
  assert.equal(empty.status, "ok");
  if (empty.status === "ok") {
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.classes, []);
    assert.equal(empty.lastSeenAt, null);
  }
  // A title-only issue contributes its class prefix, never the message.
  const titled = parseSentryUserErrors(
    sentryEnvelope([{ title: "TypeError: secret message" }])
  );
  assert.equal(JSON.stringify(titled).includes("secret"), false);
  assert.deepEqual(parseSentryUserErrors({ isError: true }), {
    reason: "sentry_malformed",
    status: "unavailable",
  });
  assert.deepEqual(parseSentryUserErrors(sentryEnvelope([{ count: {} }])), {
    reason: "sentry_malformed",
    status: "unavailable",
  });
});

const SENTRY_PATH = "sentry.user.personalSentry.search_issues";
const PLANETSCALE_PATH =
  "planetscale.org.foremanPlanetscale.planetscale_execute_read_query";
/** Bind Sentry and set the org slug for one test, then restore both. */
function withSentry(t: TestContext, slug: string | null = "acquisity") {
  const bindings = process.env.EXECUTOR_OPERATION_BINDINGS;
  const saved = process.env.WIDGET_SENTRY_ORG_SLUG;
  process.env.EXECUTOR_OPERATION_BINDINGS = JSON.stringify({
    "planetscale.readQuery": { path: PLANETSCALE_PATH },
    "sentry.searchIssues": { path: SENTRY_PATH },
  });
  if (slug === null) {
    delete process.env.WIDGET_SENTRY_ORG_SLUG;
  } else {
    process.env.WIDGET_SENTRY_ORG_SLUG = slug;
  }
  t.after(() => {
    process.env.EXECUTOR_OPERATION_BINDINGS = bindings;
    if (saved === undefined) {
      delete process.env.WIDGET_SENTRY_ORG_SLUG;
    } else {
      process.env.WIDGET_SENTRY_ORG_SLUG = saved;
    }
  });
}
function mockReads(t: TestContext, sentry: unknown, record = row) {
  return t.mock.method(
    executorTransport,
    "call",
    async (_wire: unknown, path: string) =>
      path === SENTRY_PATH ? sentry : { data: envelope(record), ok: true }
  );
}
const signals = async () => {
  const result = await readWidgetAccountAccess(ctx);
  assert.equal(result.status, "ok");
  return result.status === "ok" ? result.userErrorSignals : null;
};

test("Sentry read carries the org slug, the verified user and a bounded window", async (t) => {
  withSentry(t);
  const call = mockReads(t, {
    data: sentryEnvelope([{ count: 3, metadata: { type: "TypeError" } }]),
    ok: true,
  });
  const result = await signals();
  assert.equal(call.mock.callCount(), 2);
  const [, path, input] = call.mock.calls[1].arguments as unknown as [
    unknown,
    string,
    Record<string, string>,
  ];
  assert.equal(path, SENTRY_PATH);
  assert.deepEqual(input, {
    organizationSlug: "acquisity",
    query: `is:unresolved level:error user.id:"${scope.userId}" lastSeen:-14d`,
  });
  // An unrelated error is reported as a user error, never as a sign-in failure.
  assert.equal(result?.status, "ok");
  if (result?.status === "ok") {
    assert.deepEqual(result.classes, ["TypeError"]);
    assert.ok(result.scope.includes("not filtered to sign-in"));
    assert.equal(result.windowDays, 14);
  }
});

for (const slug of [null, "", "bad slug/../x"]) {
  test(`org slug ${JSON.stringify(slug)} makes no Sentry request`, async (t) => {
    withSentry(t, slug);
    const call = mockReads(t, { data: sentryEnvelope([]), ok: true });
    assert.deepEqual(await signals(), {
      reason: "sentry_unconfigured",
      status: "unavailable",
    });
    assert.equal(call.mock.callCount(), 1);
  });
}

test("Sentry failure, malformed and empty stay distinct and keep saved evidence", async (t) => {
  withSentry(t);
  const failed = mockReads(t, { error: { code: "upstream" }, ok: false });
  assert.deepEqual(await signals(), {
    reason: "sentry_unreachable",
    status: "unavailable",
  });
  failed.mock.restore();
  const thrown = t.mock.method(
    executorTransport,
    "call",
    (_wire: unknown, path: string) =>
      path === SENTRY_PATH
        ? Promise.reject(new Error("secret transport detail"))
        : Promise.resolve({ data: envelope(), ok: true })
  );
  assert.deepEqual(await signals(), {
    reason: "sentry_unreachable",
    status: "unavailable",
  });
  thrown.mock.restore();
  const malformed = mockReads(t, { data: { content: "nope" }, ok: true });
  assert.deepEqual(await signals(), {
    reason: "sentry_malformed",
    status: "unavailable",
  });
  malformed.mock.restore();
  mockReads(t, { data: sentryEnvelope([]), ok: true });
  const empty = await signals();
  assert.equal(empty?.status, "ok");
  if (empty?.status === "ok") {
    assert.equal(empty.total, 0);
  }
});

test("denied membership never reaches Sentry", async (t) => {
  withSentry(t);
  const call = mockReads(t, { data: sentryEnvelope([]), ok: true }, {
    ...row,
    authorized: false,
  } as typeof row);
  const result = await readWidgetAccountAccess(ctx);
  assert.equal(result.status, "denied");
  assert.equal(call.mock.callCount(), 1);
});
