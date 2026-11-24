import { after, beforeEach } from "node:test";
import type { ProviderContext } from "#lib/executor/dispatch.js";
import { resetInstantlyWorkspaceCache } from "#lib/instantly-api.js";
import { verifiedWidgetContext } from "#lib/widget.fixture.js";
import { widgetAuth } from "#lib/widget-scope.js";

// Resolved workspaces are cached per process; no test may see another's.
beforeEach(resetInstantlyWorkspaceCache);

export const scope = verifiedWidgetContext;
export const DB_PATH = "planetscale-org.planetscale_execute_read_query";
export const MEMBERS_PATH =
  "foreman-instantly-api.workspaceGroupMembers.listWorkspaceGroupMembers";
export const ACCOUNTS_PATH = "foreman-instantly-api.accounts.listAccounts";

const originalConnector = process.env.EXECUTOR_MCP_CONNECTOR_SUPPORT;
const originalBindings = process.env.EXECUTOR_OPERATION_BINDINGS;
process.env.EXECUTOR_MCP_CONNECTOR_SUPPORT = "executor.test/widget";
process.env.EXECUTOR_OPERATION_BINDINGS = JSON.stringify({
  "instantly.accounts": { path: ACCOUNTS_PATH },
  "instantly.workspace-group-members": { path: MEMBERS_PATH },
  "planetscale.readQuery": { path: DB_PATH },
});
after(() => {
  if (originalBindings === undefined) {
    delete process.env.EXECUTOR_OPERATION_BINDINGS;
  } else {
    process.env.EXECUTOR_OPERATION_BINDINGS = originalBindings;
  }
  if (originalConnector === undefined) {
    delete process.env.EXECUTOR_MCP_CONNECTOR_SUPPORT;
  } else {
    process.env.EXECUTOR_MCP_CONNECTOR_SUPPORT = originalConnector;
  }
});

export const observedAt = "2026-09-17T10:00:00.000Z";
export const baseRow = (overrides: Record<string, unknown> = {}) => ({
  accountErrors: [],
  accountType: null,
  authorized: true,
  connectionError: null,
  connectionUpdatedAt: null,
  hasConnectionError: null,
  initialWarmupEmails: [],
  isActive: null,
  lastWebhookEventAt: null,
  observedAt,
  recentWebhookErrorCount: 0,
  recentWebhookEventCount: 0,
  reconnectAttempts: [],
  savedDomains: { domains: [], total: 0 },
  savedInboxes: { inboxes: [], total: 0 },
  webhookRegisteredCount: 0,
  workspaceId: null,
  ...overrides,
});
export const dbEnvelope = (row: Record<string, unknown>) => ({
  content: [
    { text: JSON.stringify({ rows: [row], success: true }), type: "text" },
  ],
});
export const ctx = {
  abortSignal: new AbortController().signal,
  getToken: async () => ({ token: "test-token" }),
  session: { auth: { current: null, initiator: widgetAuth(scope) } },
} as unknown as ProviderContext;

/** Routes the mocked transport by operation path; unrouted paths fail the test loudly. */
export const byPath =
  (
    handlers: Record<
      string,
      () => { data: unknown; ok: true } | { error: unknown; ok: false }
    >
  ) =>
  (_wire: unknown, path: string) => {
    const handler = handlers[path];
    if (!handler) {
      throw new Error(`Unexpected executor path in test: ${path}`);
    }
    return Promise.resolve(handler());
  };
