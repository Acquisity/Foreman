import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { appProviderContext } from "./app-context.js";
import { authLane, executorAuth, laneConnector } from "./auth.js";
import { invokeProvider } from "./dispatch.js";
import { ExecutorError } from "./transport.js";

const UNKNOWN_LANE = /Unknown/u;
const LANE_ENV = {
  foreman: "EXECUTOR_MCP_CONNECTOR_FOREMAN",
  "foreman-disputes": "EXECUTOR_MCP_CONNECTOR_DISPUTES",
  "foreman-support": "EXECUTOR_MCP_CONNECTOR_SUPPORT",
} as const;

function withConnectors(t: TestContext, values: Record<string, string>) {
  const prior = Object.fromEntries(
    Object.values(LANE_ENV).map((name) => [name, process.env[name]])
  );
  for (const name of Object.values(LANE_ENV)) {
    delete process.env[name];
  }
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
}

const notConfigured = (error: unknown) =>
  (error as { reason?: string; code?: string }).reason ===
    "executor_not_configured" ||
  (error instanceof ExecutorError && error.code === "executor_not_configured");

test("each lane resolves only its own connector, with no fallback", (t) => {
  withConnectors(t, {
    EXECUTOR_MCP_CONNECTOR_DISPUTES: "c/disputes",
    EXECUTOR_MCP_CONNECTOR_FOREMAN: "c/foreman",
    EXECUTOR_MCP_CONNECTOR_SUPPORT: "c/support",
  });
  assert.equal(laneConnector("foreman"), "c/foreman");
  assert.equal(laneConnector("foreman-support"), "c/support");
  assert.equal(laneConnector("foreman-disputes"), "c/disputes");
  for (const lane of Object.keys(LANE_ENV) as (keyof typeof LANE_ENV)[]) {
    assert.equal(authLane(executorAuth(lane)), lane);
  }
  assert.equal(authLane(executorAuth()), "foreman");
  assert.throws(() => laneConnector("other" as never), UNKNOWN_LANE);

  // A lane whose connector is missing never borrows another lane's.
  for (const missing of Object.keys(LANE_ENV) as (keyof typeof LANE_ENV)[]) {
    withConnectors(
      t,
      Object.fromEntries(
        Object.entries(LANE_ENV)
          .filter(([lane]) => lane !== missing)
          .map(([lane, name]) => [name, `c/${lane}`])
      )
    );
    assert.equal(laneConnector(missing), undefined);
    assert.throws(() => executorAuth(missing), notConfigured);
  }
});

test("schedule contexts resolve the requested lane only", async (t) => {
  withConnectors(t, { EXECUTOR_MCP_CONNECTOR_FOREMAN: "c/foreman" });
  const ctx = appProviderContext(new AbortController().signal);
  // An auth definition that names no lane gets no token.
  await assert.rejects(ctx.getToken({} as never), notConfigured);
  withConnectors(t, {
    EXECUTOR_MCP_CONNECTOR_DISPUTES: "c/disputes",
    EXECUTOR_MCP_CONNECTOR_FOREMAN: "c/foreman",
  });
  const disputes = executorAuth("foreman-disputes");
  // With the disputes connector gone, the schedule context does not fall back.
  delete process.env.EXECUTOR_MCP_CONNECTOR_DISPUTES;
  await assert.rejects(ctx.getToken(disputes as never), notConfigured);
});

test("calls take the token of their lane; only dispute writes use disputes", async (t) => {
  withConnectors(t, {
    EXECUTOR_MCP_CONNECTOR_DISPUTES: "c/disputes",
    EXECUTOR_MCP_CONNECTOR_FOREMAN: "c/foreman",
    EXECUTOR_MCP_CONNECTOR_SUPPORT: "c/support",
  });
  t.mock.method(globalThis, "fetch", (_url: string, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    if (request.method === "notifications/initialized") {
      return Promise.resolve(new Response(null, { status: 202 }));
    }
    return Promise.resolve(
      Response.json({
        id: request.id,
        jsonrpc: "2.0",
        result:
          request.method === "initialize"
            ? { protocolVersion: "2025-06-18" }
            : {
                structuredContent: {
                  execution: { ok: true, value: { data: {}, ok: true } },
                  status: "completed",
                },
              },
      })
    );
  });
  const lanes: unknown[] = [];
  const ctx = {
    abortSignal: new AbortController().signal,
    getToken: (auth: unknown) => {
      lanes.push(authLane(auth));
      return Promise.resolve({ token: "t" });
    },
  };
  await invokeProvider(ctx as never, "linear.get_issue", { id: "ENG-1" });
  await invokeProvider(
    ctx as never,
    "foreman-stripe-dispute-write-sandbox.disputes.updateDisputeEvidence",
    { body: { submit: false }, dispute_id: "du_1" }
  );
  assert.deepEqual(lanes, ["foreman", "foreman-disputes"]);
});

test("the disputes connector and dispute write paths appear only where respond_stripe_dispute reaches them", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return files(path);
      }
      return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
    });
  const allowed = new Map([
    ["EXECUTOR_MCP_CONNECTOR_DISPUTES", ["lib/executor/auth.ts"]],
    [
      '"stripe.disputes.update"',
      ["lib/executor/operations.ts", "tools/respond_stripe_dispute.ts"],
    ],
    [
      '"stripe.files.create"',
      ["lib/executor/operations.ts", "tools/respond_stripe_dispute.ts"],
    ],
  ]);
  for (const [needle, owners] of allowed) {
    const found = files(root)
      .filter((path) => readFileSync(path, "utf8").includes(needle))
      .map((path) => path.slice(root.length))
      .sort((a, b) => a.localeCompare(b));
    assert.deepEqual(found, owners, needle);
  }
});
