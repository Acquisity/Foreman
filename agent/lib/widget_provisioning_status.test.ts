import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import type { ProviderContext } from "#lib/executor/dispatch.js";
import { WIDGET_TOOLKIT } from "#lib/executor/endpoint.js";
import { executorTransport } from "#lib/executor/transport.js";
import { verifiedFinContext } from "#lib/fin-investigation.fixture.js";
import { finInvestigationAuth } from "#lib/fin-investigation-auth.js";
import { verifiedWidgetContext } from "#lib/widget.fixture.js";
import { widgetAuth } from "#lib/widget-scope.js";
import definition, {
  buildWidgetProvisioningQuery,
  parseWidgetProvisioningEvidence,
  readWidgetProvisioningStatus,
  widgetProvisioningInput,
  widgetProvisioningOutput,
} from "../tools/widget_provisioning_status.js";

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

const orderId = "66666666-6666-4666-8666-666666666666";
const billingAccountId = "77777777-7777-4777-8777-777777777777";
const submissionId = "88888888-8888-4888-8888-888888888888";
const observedAt = "2026-09-17T10:00:00.000Z";
// One hour before observedAt: past the 30-minute stall heuristic.
const staleAt = "2026-09-17T09:00:00.000Z";

const rawOrder = {
  activeDomainRows: 0,
  activeInboxRows: 0,
  billingAccountId,
  completedAt: null,
  connectedInboxRows: 0,
  createdAt: staleAt,
  dfyInboxCount: null,
  dismissed: false,
  domainCount: 6,
  domainRows: 6,
  domainsProvisioned: 0,
  failedDomainRows: 0,
  hasError: false,
  id: orderId,
  inboxCountPerDomain: 3,
  inboxesProvisioned: 0,
  inboxRows: 0,
  mailProvider: "coldmailreseller",
  orderType: "pre_warmed",
  paidAt: staleAt,
  providerOrderId: "cmr_order_123",
  provisioningAttempts: 4,
  provisioningLastUpdated: staleAt,
  provisioningStartedAt: staleAt,
  status: "provisioning",
  submissionId,
  updatedAt: staleAt,
};

const envelope = (
  records: unknown[],
  options: { authorized?: boolean } = {}
) => ({
  content: [
    {
      text: JSON.stringify({
        rows: [
          {
            authorized: options.authorized ?? true,
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

test("input accepts only an optional owned order selector", () => {
  for (const input of [
    { organizationId: scope.organizationId },
    { orderId: "not-a-uuid" },
    { query: "select * from domain_purchase_order" },
    { status: "provisioning" },
  ]) {
    assert.equal(widgetProvisioningInput.safeParse(input).success, false);
    assert.throws(() => buildWidgetProvisioningQuery(scope, input as never));
  }
  assert.ok(widgetProvisioningInput.safeParse({}).success);
  assert.ok(widgetProvisioningInput.safeParse({ orderId: null }).success);
  assert.equal(
    buildWidgetProvisioningQuery(scope, { orderId: null }),
    buildWidgetProvisioningQuery(scope, {})
  );
  const selected = buildWidgetProvisioningQuery(scope, { orderId });
  assert.ok(selected.includes(`where dpo.id = '${orderId}'::uuid`));
  assert.ok(
    selected.includes("join authorized a on a.id = dpo.organization_id")
  );
  assert.ok(selected.includes("limit 10"));
  assert.ok(selected.includes("limit 5"));
  assert.equal(selected.includes("error_details"), false);
});

test("the statement checks membership and scopes every provisioning join", () => {
  const query = buildWidgetProvisioningQuery(scope, {});
  for (const required of [
    scope.organizationId,
    scope.userId,
    "m.deleted_at is null",
    "o.deleted_at is null",
    "m.role in ('owner', 'admin')",
    "o.partner_id",
    "join authorized a on a.id = dpo.organization_id",
    "count(*) = 1",
    "md.organization_id = dpo.organization_id and md.order_id = dpo.id",
    "mi.organization_id = dpo.organization_id and mi.order_id = dpo.id",
    `limit ${25}`,
    "dpo.order_type = 'dfy'",
    "jsonb_typeof(dpo.dfy_config -> 'mailboxes') = 'object'",
    "jsonb_array_length(mb.value)",
  ]) {
    assert.ok(query.includes(required), required);
  }
  for (const forbidden of [
    "select *",
    "buyer_email",
    "domain_search",
    "selected_domains",
    "dfy_config as",
    "dfy_config -> 'domains'",
    "jsonb_object_keys",
    "checkout_lease",
    "md.domain",
    "mi.email",
  ]) {
    assert.equal(query.includes(forbidden), false, forbidden);
  }
});

test("dispatch sends the org-scoped query through the widget toolkit", async (t) => {
  const call = t.mock.method(executorTransport, "call", async () => ({
    data: envelope([rawOrder]),
    ok: true,
  }));
  const result = await readWidgetProvisioningStatus(ctx, {});
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

test("output matches the schema and reconciles charged versus provisioned", () => {
  const result = parseWidgetProvisioningEvidence(envelope([rawOrder]), scope);
  assert.ok(z.toJSONSchema(widgetProvisioningOutput));
  assert.ok(widgetProvisioningOutput.safeParse(result).success);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    assert.fail("Expected provisioning evidence");
  }
  assert.equal(result.workspace, scope.organizationName);
  const [row] = result.orders;
  assert.equal(row.runState, "stalled");
  assert.equal(row.step, "0/6");
  assert.equal(
    row.provisioningFunctionId,
    "ai-clients.campaigns.domain-purchase-order"
  );
  assert.equal(row.reconciliation.domainsCharged, 6);
  assert.equal(row.reconciliation.inboxesCharged, 18);
  assert.equal(row.reconciliation.domainsMissing, 6);
  assert.equal(row.reconciliation.inboxesMissing, 18);
  assert.equal(row.reconciliation.invisibleInboxes, true);
  assert.equal(row.reconciliation.fullyProvisioned, false);
});

test("run state and reconciliation follow status, staleness and live rows", () => {
  const cases: [Record<string, unknown>, string, boolean][] = [
    // A provisioning order whose last activity is recent is running, not stalled.
    [
      { provisioningLastUpdated: observedAt, updatedAt: observedAt },
      "running",
      false,
    ],
    [{ completedAt: observedAt, status: "completed" }, "completed", false],
    [{ status: "requires_attention" }, "failed", false],
    [{ hasError: true, status: "failed" }, "failed", false],
    [{ status: "cancelled" }, "cancelled", false],
    [{ status: "refunded" }, "cancelled", false],
    [{ status: "cancellation_in_progress" }, "cancelling", false],
    [{ paidAt: null, status: "pending_payment" }, "awaiting_payment", false],
    [{ status: "paid" }, "queued", false],
    // Fully provisioned: live rows meet the charged counts.
    [
      {
        activeDomainRows: 6,
        activeInboxRows: 18,
        connectedInboxRows: 18,
        domainsProvisioned: 6,
        inboxesProvisioned: 18,
        inboxRows: 18,
        status: "completed",
      },
      "completed",
      true,
    ],
  ];
  for (const [patch, expectedRunState, expectedFull] of cases) {
    const result = parseWidgetProvisioningEvidence(
      envelope([{ ...rawOrder, ...patch }]),
      scope
    );
    assert.equal(result.status, "ok");
    if (result.status !== "ok") {
      assert.fail("Expected provisioning evidence");
    }
    assert.equal(result.orders[0].runState, expectedRunState, expectedRunState);
    assert.equal(
      result.orders[0].reconciliation.fullyProvisioned,
      expectedFull,
      `fullyProvisioned ${expectedRunState}`
    );
  }
});

test("DFY inbox quantity comes from the mailbox aggregate, never the multiplier", () => {
  const dfy = {
    ...rawOrder,
    activeDomainRows: 1,
    domainCount: 1,
    domainsProvisioned: 1,
    inboxCountPerDomain: 0,
    orderType: "dfy",
    status: "completed",
  };
  const cases: [
    Record<string, unknown>,
    number | null,
    number | null,
    boolean | null,
  ][] = [
    // Verified case: zero multiplier, three configured mailboxes, three active inboxes.
    [{ activeInboxRows: 3, dfyInboxCount: 3, inboxRows: 3 }, 3, 0, true],
    // Unequal mailbox counts across domains (2 + 5) arrive as one aggregate.
    [
      {
        activeDomainRows: 2,
        activeInboxRows: 4,
        dfyInboxCount: 7,
        domainCount: 2,
        inboxCountPerDomain: 3,
        inboxRows: 4,
      },
      7,
      3,
      false,
    ],
    // Missing or malformed configuration: unknown, not zero and not complete.
    [
      { activeInboxRows: 3, dfyInboxCount: null, inboxRows: 3 },
      null,
      null,
      null,
    ],
    // A non-DFY order ignores any aggregate and keeps the multiplier.
    [
      {
        activeDomainRows: 6,
        activeInboxRows: 18,
        dfyInboxCount: 99,
        domainCount: 6,
        inboxCountPerDomain: 3,
        inboxRows: 18,
        orderType: "pre_warmed",
      },
      18,
      0,
      true,
    ],
  ];
  for (const [patch, charged, missing, full] of cases) {
    const result = parseWidgetProvisioningEvidence(
      envelope([{ ...dfy, ...patch }]),
      scope
    );
    assert.ok(widgetProvisioningOutput.safeParse(result).success);
    if (result.status !== "ok") {
      assert.fail("Expected provisioning evidence");
    }
    const { reconciliation } = result.orders[0];
    assert.equal(reconciliation.inboxesCharged, charged);
    assert.equal(reconciliation.inboxesMissing, missing);
    assert.equal(reconciliation.fullyProvisioned, full);
    assert.equal(reconciliation.invisibleInboxes, false);
  }
  // Configured DFY inboxes with no inbox rows at all are still flagged invisible.
  const invisible = parseWidgetProvisioningEvidence(
    envelope([{ ...dfy, dfyInboxCount: 3 }]),
    scope
  );
  assert.equal(
    invisible.status === "ok" &&
      invisible.orders[0].reconciliation.invisibleInboxes,
    true
  );
});

test("empty, denied and unavailable stay distinct; unavailable never leaks values", async (t) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  const empty = parseWidgetProvisioningEvidence(envelope([]), scope);
  assert.equal(empty.status, "ok");
  if (empty.status === "ok") {
    assert.deepEqual(empty.orders, []);
  }
  assert.equal(
    parseWidgetProvisioningEvidence(
      envelope([rawOrder], { authorized: false }),
      scope
    ).status,
    "denied"
  );
  t.mock.method(executorTransport, "call", async () => ({
    error: { code: "oauth_reauth_required", message: "secret upstream detail" },
    ok: false,
  }));
  const failed = await readWidgetProvisioningStatus(ctx, {});
  assert.equal(failed.status, "unavailable");
  assert.equal(JSON.stringify(failed).includes("secret"), false);
  assert.equal(warning.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(String(warning.mock.calls[0].arguments[0])), {
    code: "transport",
    event: "widget.support.provisioning_status.failed",
    outcome: "error",
    tool: "widget_provisioning_status",
  });
});

test("malformed rows become unavailable without leaking values, and extra fields are dropped", async (t) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  t.mock.method(executorTransport, "call", async () => ({
    data: envelope([{ ...rawOrder, status: "secret provider value" }]),
    ok: true,
  }));
  const result = await readWidgetProvisioningStatus(ctx, {});
  assert.equal(result.status, "unavailable");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(
    JSON.parse(String(warning.mock.calls[0].arguments[0])).code,
    "response"
  );
  const extra = parseWidgetProvisioningEvidence(
    envelope([
      { ...rawOrder, buyerEmail: "secret@example.com", dfyConfig: "secret" },
    ]),
    scope
  );
  assert.equal(extra.status, "ok");
  assert.equal(JSON.stringify(extra).includes("secret"), false);
});

test("non-widget sessions are refused before any dispatch", async (t) => {
  t.mock.method(executorTransport, "call", () =>
    assert.fail("must not dispatch")
  );
  await assert.rejects(
    readWidgetProvisioningStatus(
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

test("owned saved logs expose partial failures and retries without provider blobs", () => {
  const record = {
    ...rawOrder,
    diagnostics: {
      domains: [
        {
          credentials: "discarded-domain-secret",
          domain: "example.com",
          error: "Provider rejected token=verysecret123",
          expectedInboxes: 3,
          inboxCount: 1,
          inboxes: [
            {
              connected: false,
              connectionError: "Authentication failed Bearer abcdefghijklmnop",
              lastRetryAt: staleAt,
              password: "discarded-provider-password",
              retryCount: 2,
            },
          ],
          inboxesTruncated: true,
          provisionedAt: null,
          status: "partial",
        },
      ],
      domainsTruncated: true,
    },
    error:
      "Connection rejected password=verysecret123 for person@example.com https://provider.test/?signature=private-signature",
    errorDetails: { password: "discarded-order-secret" },
  };
  const result = parseWidgetProvisioningEvidence(envelope([record]), scope);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    assert.fail("Expected evidence");
  }
  const [item] = result.orders;
  assert.equal(item.diagnostics?.domains[0].status, "partial");
  assert.equal(item.diagnostics?.domains[0].inboxes[0].retryCount, 2);
  assert.equal(item.diagnostics?.domains[0].expectedInboxes, 3);
  assert.equal(item.diagnostics?.domainsTruncated, true);
  assert.equal(item.diagnostics?.domains[0].inboxesTruncated, true);
  for (const secret of [
    "verysecret123",
    "person@example.com",
    "abcdefghijklmnop",
    "discarded-",
    "private-signature",
  ]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.equal(
    parseWidgetProvisioningEvidence(
      envelope([record], { authorized: false }),
      scope
    ).status,
    "denied"
  );
  const missing = parseWidgetProvisioningEvidence(
    envelope([
      {
        ...rawOrder,
        diagnostics: {
          domains: [
            {
              domain: "example.com",
              error: null,
              expectedInboxes: null,
              inboxCount: null,
              inboxes: [],
              inboxesTruncated: false,
              provisionedAt: null,
              status: "pending",
            },
          ],
          domainsTruncated: false,
        },
      },
    ]),
    scope
  );
  assert.equal(
    missing.status === "ok" &&
      missing.orders[0].diagnostics?.domains[0].expectedInboxes,
    null
  );
});

const ATTEMPTS_GUARD =
  /jsonb_typeof\(dpo\.provisioning_log -> 'totalAttempts'\) = 'number'\s+and \(dpo\.provisioning_log ->> 'totalAttempts'\) ~ '([^']+)'\s+then \(dpo\.provisioning_log ->> 'totalAttempts'\)::int end/u;

test("a malformed attempt count in one order's log does not fail the whole read", () => {
  const query = buildWidgetProvisioningQuery(scope, {});
  const guard = ATTEMPTS_GUARD.exec(query)?.[1];
  assert.ok(guard, "the totalAttempts cast is guarded");
  const integer = new RegExp(guard, "u");
  assert.equal(integer.test("3"), true);
  for (const bad of ["3.0", "", "abc", "-1", "1e3", "12345678901"]) {
    assert.equal(integer.test(bad), false, bad);
  }
  assert.equal(
    query.replace(ATTEMPTS_GUARD, "").includes("'totalAttempts')::int"),
    false
  );
});
