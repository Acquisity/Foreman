import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { neonConfig } from "@neondatabase/serverless";
import { supportAuth } from "../lib/support/auth.js";
import provider from "./support_provider.js";

test("support_provider describe then call preserves canonical v2 path, query and headers", async (t) => {
  const prior = {
    connector: process.env.EXECUTOR_MCP_CONNECTOR_SUPPORT,
    database: process.env.FOREMAN_MEMORY_DATABASE_URL,
    enabled: process.env.FOREMAN_SUPPORT_ENABLED,
    fetch: neonConfig.fetchFunction,
  };
  process.env.EXECUTOR_MCP_CONNECTOR_SUPPORT = "placeholder/support-test";
  process.env.FOREMAN_SUPPORT_ENABLED = "true";
  process.env.FOREMAN_MEMORY_DATABASE_URL =
    "postgresql://test@support.invalid/test";
  t.after(() => {
    neonConfig.fetchFunction = prior.fetch;
    for (const [key, value] of [
      ["EXECUTOR_MCP_CONNECTOR_SUPPORT", prior.connector],
      ["FOREMAN_MEMORY_DATABASE_URL", prior.database],
      ["FOREMAN_SUPPORT_ENABLED", prior.enabled],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  const row = {
    conversation: "123456",
    delivery_attempted: false,
    last_report_hash: null,
    linear_ids: [],
    linear_observed: {},
    linear_processed: {},
    processed_version: null,
    report: null,
    report_key: null,
    report_kind: null,
    report_revision: null,
    thread: "1788959233.418909",
    version: null,
  };
  neonConfig.fetchFunction = () =>
    Promise.resolve(
      Response.json({
        fields: Object.keys(row).map((name) => ({ dataTypeID: 3802, name })),
        rowCount: 1,
        rows: [Object.values(row).map((value) => JSON.stringify(value))],
      })
    );
  const auth = supportAuth(
    {
      attributes: {},
      authenticator: "app",
      principalId: "eve:app",
      principalType: "runtime",
    },
    {
      conversation: row.conversation,
      lease: "a028bfa1-68ec-477c-b6b1-e6c042173826",
      thread: row.thread,
    }
  );
  const ctx = {
    abortSignal: new AbortController().signal,
    getToken: () => Promise.resolve({ token: "synthetic" }),
    session: { auth: { current: auth, initiator: auth } },
  };
  const cases = [
    {
      input: { path: { appId: "a", functionId: "f" }, query: { limit: 5 } },
      path: "foreman-inngest-api.apps.listFunctionRuns",
    },
    {
      input: {
        headers: { "x-as-workspace": "workspace" },
        query: { limit: 20 },
      },
      path: "foreman-instantly-api.accounts.listAccounts",
    },
  ];
  const seen: unknown[] = [];
  const tools = {
    "foreman-inngest-api": {
      "apps.listFunctionRuns": (input: unknown) => {
        seen.push(input);
        return { data: [] };
      },
    },
    "foreman-instantly-api": {
      "accounts.listAccounts": (input: unknown) => {
        seen.push(input);
        return { items: [] };
      },
    },
    search: {
      describe: ({ paths }: { paths: string[] }) => ({
        input: cases.find((entry) => entry.path === paths[0])?.input,
      }),
    },
  };
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (request.method === "initialize") {
        return Response.json({
          id: request.id,
          jsonrpc: "2.0",
          result: { protocolVersion: "2025-06-18" },
        });
      }
      const value = await runInNewContext(
        `(async () => { ${request.params.arguments.code} })()`,
        { tools }
      );
      return Response.json({
        id: request.id,
        jsonrpc: "2.0",
        result: {
          structuredContent: {
            execution: { ok: true, value },
            status: "completed",
          },
        },
      });
    }
  );
  const resolve = provider.events["step.started"];
  assert.ok(resolve);
  const tool = await resolve({} as never, ctx as never);
  assert.ok(tool);
  for (const entry of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: describe must precede its call.
    const described = (await tool.execute(
      { action: "describe", path: entry.path },
      ctx as never
    )) as { input: Record<string, unknown> };
    await tool.execute(
      { action: "call", input: described.input, path: entry.path },
      ctx as never
    );
  }
  assert.deepEqual(
    JSON.parse(JSON.stringify(seen)),
    cases.map((entry) => entry.input)
  );
});
