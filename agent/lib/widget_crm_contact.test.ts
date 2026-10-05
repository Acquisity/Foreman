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
  buildWidgetCrmContactQuery,
  readWidgetCrmContact,
  widgetCrmContactInput,
} from "../tools/widget_crm_contact.js";

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

const ctx = {
  abortSignal: new AbortController().signal,
  getToken: async () => ({ token: "test-token" }),
  session: { auth: { current: null, initiator: widgetAuth(scope) } },
} as unknown as ProviderContext;

const envelope = (
  emailMatches: unknown[],
  nameMatches: unknown[] | null = null,
  authorized = true
) => ({
  content: [
    {
      text: JSON.stringify({
        rows: [
          {
            authorized,
            email_matches: emailMatches,
            name_matches: nameMatches,
            workspace: authorized ? "Test Workspace" : null,
          },
        ],
        success: true,
      }),
      type: "text",
    },
  ],
});

const person = (i: number, emails = 1) => ({
  emails: Array.from({ length: emails }, (_, n) => `p${i}-${n}@example.com`),
  id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
  name: `Person ${i}`,
});

test("tool is exposed only for the widget support initiator", () => {
  const resolve = definition.events["step.started"];
  assert.ok(resolve);
  assert.ok(resolve({} as never, ctx as never));
  for (const initiator of [
    null,
    finInvestigationAuth(verifiedFinContext),
    { attributes: {}, issuer: "slack" },
  ]) {
    assert.equal(
      resolve(
        {} as never,
        {
          session: { auth: { current: widgetAuth(scope), initiator } },
        } as never
      ),
      null
    );
  }
});

test("input requires an exact email and rejects anything else", () => {
  assert.ok(widgetCrmContactInput.safeParse({ email: "a@b.co" }).success);
  assert.ok(
    widgetCrmContactInput.safeParse({ email: "a@b.co", name: "Jane" }).success
  );
  for (const bad of [
    {},
    { email: "not-an-email" },
    { email: "a@b.co' or 1=1 --" },
    { email: `${"a".repeat(320)}@b.co` },
    { email: "a@b.co", organizationId: scope.organizationId },
    { email: "a@b.co", query: "select 1" },
    { email: "a@b.co", name: "x".repeat(101) },
  ]) {
    assert.equal(widgetCrmContactInput.safeParse(bad).success, false);
    assert.throws(() => buildWidgetCrmContactQuery(scope, bad as never));
  }
});

test("query is org scoped, re-checks membership and matches email case-insensitively", () => {
  const q = buildWidgetCrmContactQuery(scope, {
    email: "Jane.O'Neil@Example.com",
    name: "O'Neil",
  });
  for (const required of [
    `o.id = '${scope.organizationId}'::uuid`,
    `m.user_id = '${scope.userId}'::uuid`,
    "m.role in ('owner','admin')",
    `(o.partner_id is null or o.partner_id = '${scope.partnerId}'::uuid)`,
    "join authorized a on a.id = c.organization_id",
    "c.deleted_at is null and c.merged_into_contact_id is null",
    "lower(m.email) = lower('Jane.O''Neil@Example.com')",
    "strpos(lower(c.name), lower('O''Neil')) > 0",
    "limit 11",
  ]) {
    assert.ok(q.includes(required), required);
  }
  assert.equal(q.includes("O'Neil"), false);
  assert.ok(
    buildWidgetCrmContactQuery(scope, { email: "a@b.co" }).includes(
      "null::json as name_matches"
    )
  );
});

test("dispatch sends the org-scoped query through the widget toolkit and bounds rows", async (t) => {
  const call = t.mock.method(executorTransport, "call", async () => ({
    data: envelope(
      Array.from({ length: 11 }, (_, i) => person(i, i === 0 ? 11 : 1)),
      [person(99)]
    ),
    ok: true,
  }));
  const result = await readWidgetCrmContact(ctx, {
    email: "p0-0@example.com",
    name: "Person",
  });
  assert.equal(call.mock.callCount(), 1);
  const [wire, , input] = call.mock.calls[0].arguments as unknown as [
    { toolkit: string },
    string,
    { query: string },
  ];
  assert.equal(wire.toolkit, WIDGET_TOOLKIT);
  assert.ok(input.query.includes(scope.organizationId));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    return;
  }
  assert.equal(result.emailMatches.length, 10);
  assert.equal(result.emailMatchesTruncated, true);
  assert.equal(result.emailMatches[0].emails.length, 10);
  assert.equal(result.emailMatches[0].emailsTruncated, true);
  assert.equal(result.nameMatches?.length, 1);
  assert.equal(result.nameMatchesTruncated, false);
});

test("empty, denied and unavailable stay distinct", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  t.mock.method(executorTransport, "call", async () => ({
    data: envelope([]),
    ok: true,
  }));
  const empty = await readWidgetCrmContact(ctx, { email: "a@b.co" });
  assert.equal(empty.status, "ok");
  assert.deepEqual(empty.status === "ok" ? empty.emailMatches : null, []);
  assert.equal(empty.status === "ok" ? empty.nameMatches : "x", null);

  t.mock.method(executorTransport, "call", async () => ({
    data: envelope([], null, false),
    ok: true,
  }));
  assert.equal(
    (await readWidgetCrmContact(ctx, { email: "a@b.co" })).status,
    "denied"
  );

  t.mock.method(executorTransport, "call", () =>
    Promise.reject(new Error("boom"))
  );
  assert.equal(
    (await readWidgetCrmContact(ctx, { email: "a@b.co" })).status,
    "unavailable"
  );
  assert.ok(warn.mock.callCount() >= 1);
});

test("non-widget session is refused before dispatch", async (t) => {
  const call = t.mock.method(executorTransport, "call", async () => ({
    data: envelope([]),
    ok: true,
  }));
  const finCtx = {
    ...ctx,
    session: {
      auth: {
        current: null,
        initiator: finInvestigationAuth(verifiedFinContext),
      },
    },
  } as unknown as ProviderContext;
  await assert.rejects(() => readWidgetCrmContact(finCtx, { email: "a@b.co" }));
  assert.equal(call.mock.callCount(), 0);
});
