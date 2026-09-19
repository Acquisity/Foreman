import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext } from "#lib/widget.fixture.js";
import { widgetAuth } from "#lib/widget-scope.js";
import definition, {
  buildWidgetWebsiteStatusQuery,
  parseWidgetWebsiteStatus,
  readWidgetWebsiteStatus,
} from "../tools/widget_website_status.js";

const CANCELLED_RE = /cancelled/;

const scope = verifiedWidgetContext;
const observedAt = "2026-09-16T18:00:00.000Z";
const initiator = widgetAuth(scope);
const PROJECT_ROWS = 31;

const neverPublished = {
  currentStatus: "failed",
  domains: [
    { domain: "shop.example.com", state: "vercel_connected", verified: false },
  ],
  everPublished: false,
  id: "44444444-4444-4444-8444-444444444444",
  lastBuildFailureReason: "bun run build exited with 1",
  lastDeployment: {
    deploymentId: "dpl_a",
    provider: "vercel",
    state: "failed",
  },
  name: "Landing page",
  source: "website_project",
  updatedAt: observedAt,
};
const publishedThenBroke = {
  currentStatus: "failed",
  domains: [],
  everPublished: true,
  id: "55555555-5555-4555-8555-555555555555",
  lastBuildFailureReason: "later build broke",
  lastDeployment: {
    deploymentId: "dpl_b",
    provider: "vercel",
    state: "failed",
  },
  name: "Old site",
  source: "website",
  updatedAt: observedAt,
};

const envelope = (records: unknown[], authorized = true, extra = {}) => ({
  content: [
    {
      text: JSON.stringify({
        rows: [{ authorized, observedAt, records }],
        success: true,
        ...extra,
      }),
      type: "text",
    },
  ],
});

const context = (
  dispatchInitiator: unknown = initiator,
  signal: AbortSignal = new AbortController().signal
) =>
  ({
    abortSignal: signal,
    session: { auth: { current: initiator, initiator: dispatchInitiator } },
  }) as never;

test("only the widget-support lane is offered this evidence tool", () => {
  const resolve = definition.events["step.started"];
  assert.ok(resolve);
  assert.ok(resolve({} as never, context()));
  for (const other of [null, { issuer: "slack" }, { issuer: "github" }]) {
    assert.equal(resolve({} as never, context(other)), null);
  }
});

test("every read re-checks membership and scopes each product join to the workspace", () => {
  const query = buildWidgetWebsiteStatusQuery(scope);
  for (const required of [
    scope.organizationId,
    scope.userId,
    "m.deleted_at is null",
    "o.deleted_at is null",
    "m.role in ('owner', 'admin')",
    "o.partner_id",
    "join authorized a",
    "count(*) = 1",
    "wd.organization_id = a.id",
    "wc.organization_id = a.id",
    "bd.organization_id = a.id",
    "p.deleted_at is null",
    "w.deleted_at is null",
  ]) {
    assert.ok(query.includes(required), required);
  }
  for (const forbidden of ["credentials", "password", "generation_error"]) {
    assert.equal(query.includes(forbidden), false, forbidden);
  }
});

test("output matches the schema and distinguishes never-published from published-then-broke", () => {
  const result = parseWidgetWebsiteStatus(
    envelope([neverPublished, publishedThenBroke]),
    scope
  );
  assert.equal(result.status, "ok");
  if (result.status !== "ok") {
    assert.fail("expected ok evidence");
  }
  assert.equal(result.truncated, false);
  const [first, second] = result.projects;
  // The 404 cause: a connected domain on a project that never published.
  assert.equal(first.everPublished, false);
  assert.equal(first.currentStatus, "failed");
  assert.ok(first.domains.length > 0);
  // Same failed status, but this one did publish before it broke.
  assert.equal(second.everPublished, true);
  assert.notEqual(first.everPublished, second.everPublished);
  assert.equal(second.lastDeployment?.state, "failed");
});

test("empty is a valid ok result and stays distinct from unavailable and denied", () => {
  const empty = parseWidgetWebsiteStatus(envelope([]), scope);
  assert.equal(empty.status, "ok");
  if (empty.status === "ok") {
    assert.deepEqual(empty.projects, []);
  }
  const denied = parseWidgetWebsiteStatus(
    envelope([neverPublished], false),
    scope
  );
  assert.equal(denied.status, "denied");
  // A warning means rows were hidden; an incomplete read must never parse as empty.
  assert.throws(() =>
    parseWidgetWebsiteStatus(
      envelope([], true, { warnings: ["RLS hid rows"] }),
      scope
    )
  );
});

test("a provider failure returns unavailable, never empty, and never leaks provider detail", async (t) => {
  const warning = t.mock.method(console, "warn", () => undefined);
  const failing = () =>
    Promise.reject(new Error("secret upstream oauth detail"));
  const result = await readWidgetWebsiteStatus(context(), failing);
  assert.equal(result.status, "unavailable");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(result).includes("oauth"), false);
  assert.equal(warning.mock.callCount(), 1);
  assert.equal(
    JSON.parse(String(warning.mock.calls[0].arguments[0])).tool,
    "widget_website_status"
  );
});

test("the dispatched query carries the verified scope and paging stays bounded", async () => {
  let captured = "";
  const rows = Array.from({ length: PROJECT_ROWS }, (_, i) => ({
    ...neverPublished,
    id: `${String(i).padStart(8, "0")}-4444-4444-8444-444444444444`,
  }));
  const result = await readWidgetWebsiteStatus(context(), (query) => {
    captured = query;
    return Promise.resolve(envelope(rows));
  });
  assert.ok(captured.includes(scope.organizationId));
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.truncated, true);
    assert.equal(result.projects.length, 30);
  }
});

test("a non-widget initiator is refused before any dispatch, and aborts stay aborted", async () => {
  await assert.rejects(
    readWidgetWebsiteStatus(context({ issuer: "slack" }), () =>
      assert.fail("must not dispatch")
    )
  );
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    readWidgetWebsiteStatus(context(initiator, controller.signal), () =>
      Promise.reject(controller.signal.reason)
    ),
    CANCELLED_RE
  );
});
