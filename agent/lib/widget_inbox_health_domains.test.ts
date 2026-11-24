import assert from "node:assert/strict";
import { test } from "node:test";
import { executorTransport } from "#lib/executor/transport.js";
import { member, WORKSPACE_ID } from "#lib/instantly-fixtures.js";
import {
  ACCOUNTS_PATH,
  baseRow,
  byPath,
  ctx,
  DB_PATH,
  dbEnvelope,
  MEMBERS_PATH,
  observedAt,
  scope,
} from "#lib/widget_inbox_health.fixture.js";
import {
  buildWidgetInboxHealthQuery,
  domainReason,
  readWidgetInboxHealth,
  widgetInboxHealthOutput,
} from "../tools/widget_inbox_health.js";

const INTERNAL_WORDS = /ENG-|Instantly/u;

const suspendedDomain = {
  autoRenew: true,
  billingStop: {
    attempts: 1,
    requestedAt: "2026-11-06T00:00:17.248613+00:00",
    status: "cancelled",
    stoppedAt: "2026-11-06T00:09:41.861+00:00",
  },
  connectedInboxes: 3,
  domain: "Ended.example.test",
  expiresAt: "2026-12-06T13:32:16.889+00:00",
  reason: "Cancelled by user",
  savedInboxes: 3,
  status: "suspended",
  updatedAt: "2026-11-16T23:00:06.018387+00:00",
};
const failedStop = {
  ...suspendedDomain,
  billingStop: {
    attempts: 4,
    requestedAt: "2026-11-20T00:00:00+00:00",
    status: "failed",
    stoppedAt: null,
  },
  domain: "stuck.example.test",
  reason: "Cancelled after provider mailbox loss",
  status: "cancelling",
};

test("the domain read stays inside the authorized workspace and lists every domain not active first", () => {
  const query = buildWidgetInboxHealthQuery(scope);
  for (const required of [
    "from mail_domain md join authorized a on a.id = md.organization_id",
    "where mi.domain_id = md.id and mi.organization_id = md.organization_id",
    "where c.mail_domain_id = md.id and c.organization_id = md.organization_id",
    "md.status = 'active' as active",
    "order by active, domain limit 50",
  ]) {
    assert.ok(query.includes(required), required);
  }
});

test("a suspended domain reports why it ended, when its billing stopped, and whether its mailboxes are still live", async (t) => {
  const row = baseRow({
    accountType: "system_provisioned",
    connectionUpdatedAt: observedAt,
    hasConnectionError: false,
    isActive: true,
    savedDomains: {
      domains: [
        suspendedDomain,
        failedStop,
        {
          ...suspendedDomain,
          domain: "odd.example.test",
          reason: "TypeError: x is undefined",
        },
      ],
      total: 3,
    },
    workspaceId: WORKSPACE_ID,
  });
  t.mock.method(
    executorTransport,
    "call",
    byPath({
      [ACCOUNTS_PATH]: () => ({
        data: {
          items: [
            { email: "a@ended.example.test", status: 1 },
            { email: "b@Ended.Example.test", status: 2 },
            { email: "c@other.example.test", status: 1 },
          ],
          next_starting_after: null,
        },
        ok: true,
      }),
      [DB_PATH]: () => ({ data: dbEnvelope(row), ok: true }),
      [MEMBERS_PATH]: () => ({
        data: {
          items: [member({ sub_workspace_id: WORKSPACE_ID })],
          next_starting_after: null,
        },
        ok: true,
      }),
    })
  );
  const result = await readWidgetInboxHealth(ctx);
  assert.ok(widgetInboxHealthOutput.safeParse(result).success);
  if (result.status !== "ok" || !result.savedDomains) {
    assert.fail("expected saved domains");
  }
  assert.equal(result.savedDomains.total, 3);
  assert.deepEqual(result.savedDomains.domains[0], {
    ...suspendedDomain,
    liveAccounts: 2,
    reason: "Cancelled from the workspace",
  });
  assert.deepEqual(
    result.savedDomains.domains.slice(1).map((domain) => ({
      billingStop: domain.billingStop?.status,
      liveAccounts: domain.liveAccounts,
      reason: domain.reason,
    })),
    [
      {
        billingStop: "failed",
        liveAccounts: 0,
        reason: "Cancelled after its mailboxes were lost at the email supplier",
      },
      {
        billingStop: "cancelled",
        liveAccounts: 0,
        reason:
          "A diagnostic was recorded; its technical details are unavailable",
      },
    ]
  );
});

test("saved domains are returned with no live count when the live check cannot run", async (t) => {
  t.mock.method(
    executorTransport,
    "call",
    byPath({
      [DB_PATH]: () => ({
        data: dbEnvelope(
          baseRow({
            savedDomains: { domains: [suspendedDomain], total: 1 },
          })
        ),
        ok: true,
      }),
    })
  );
  const result = await readWidgetInboxHealth(ctx);
  if (result.status !== "ok" || !result.savedDomains) {
    assert.fail("expected saved domains");
  }
  assert.equal(result.accounts.available, false);
  assert.equal(result.savedDomains.domains[0].liveAccounts, null);
  assert.equal(
    result.savedDomains.domains[0].reason,
    "Cancelled from the workspace"
  );
});

test("every reason Acquisity saves on an ended domain has authored wording", () => {
  // Every non-empty mail_domain.error on an ended domain in production, 24 Nov 2026.
  const saved = [
    "Cancelled by user",
    "Removed because the domain subscription ended",
    "Cancelled because the plan ended",
    "Timeout waiting for domain/mailboxes",
    "Cancelled because the workspace owner was banned",
    "Suspended by billing overage reconciliation",
    "Domain or mailbox provisioning failed",
    "Cancelled after unpaid mailbox cleanup",
    "Cancelled: unpaid and expired vendor inboxes reconciled (ENG-14776)",
    "Cancelled after provider mailbox loss",
    "Instantly has not delivered this inbox yet",
    "Cancelled: expired vendor inboxes reconciled (ENG-14268)",
    "Expired at provider (ENG-14945)",
  ];
  const generic = domainReason("something new");
  // The shared diagnostic wording would call this a paused campaign.
  assert.equal(domainReason("Domain subscription expired"), generic);
  for (const reason of saved) {
    const worded = domainReason(reason);
    assert.ok(worded && worded !== generic, reason);
    assert.ok(!INTERNAL_WORDS.test(worded), worded);
  }
  assert.equal(domainReason(null), null);
});

const provisioned = (domains: unknown[]) =>
  baseRow({
    accountType: "system_provisioned",
    connectionUpdatedAt: observedAt,
    hasConnectionError: false,
    isActive: true,
    savedDomains: { domains, total: domains.length },
    workspaceId: WORKSPACE_ID,
  });
const acceptedMember = () => ({
  data: {
    items: [member({ sub_workspace_id: WORKSPACE_ID })],
    next_starting_after: null,
  },
  ok: true as const,
});

test("a sampled account read gives no live count, since the domain's mailboxes may be on an unread page", async (t) => {
  t.mock.method(
    executorTransport,
    "call",
    byPath({
      [ACCOUNTS_PATH]: () => ({
        data: {
          items: [{ email: "a@other.example.test", status: 1 }],
          next_starting_after: "more",
        },
        ok: true,
      }),
      [DB_PATH]: () => ({
        data: dbEnvelope(provisioned([suspendedDomain])),
        ok: true,
      }),
      [MEMBERS_PATH]: acceptedMember,
    })
  );
  const result = await readWidgetInboxHealth(ctx);
  if (result.status !== "ok" || result.accounts.available !== true) {
    return assert.fail("live check did not run");
  }
  assert.equal(result.accounts.truncated, true);
  assert.equal(result.savedDomains?.domains[0].liveAccounts, null);
});

test("an Instantly failure gives no live count rather than zero", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(
    executorTransport,
    "call",
    byPath({
      [DB_PATH]: () => ({
        data: dbEnvelope(provisioned([suspendedDomain])),
        ok: true,
      }),
      [MEMBERS_PATH]: () => ({
        error: { code: "oauth_reauth_required", status: 403 },
        ok: false,
      }),
    })
  );
  const result = await readWidgetInboxHealth(ctx);
  if (result.status !== "ok") {
    return assert.fail("expected an ok read");
  }
  assert.equal(result.accounts.available, false);
  assert.equal(result.savedDomains?.domains[0].liveAccounts, null);
});
