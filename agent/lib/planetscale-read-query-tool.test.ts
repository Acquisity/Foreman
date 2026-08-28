import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PRODUCTION_READ_QUERY_ARGS } from "./lookup-customer.js";

process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planet-scale-read-only-foreman/test";

const { default: tool } = await import(
  "../tools/planetscale_execute_read_query.js"
);

const jsonResponse = (body: unknown, headers: Record<string, string> = {}) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json", ...headers },
      status: 200,
    })
  );

describe("planetscale_execute_read_query tool", () => {
  it("fills in the production coordinates when the model passes only the query", async () => {
    const calls: { method: string; params?: unknown }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params?: unknown;
      };
      calls.push(body);
      if (body.method === "initialize") {
        return jsonResponse(
          { id: 1, jsonrpc: "2.0", result: { protocolVersion: "2025-06-18" } },
          { "mcp-session-id": "s1" }
        );
      }
      if (body.method === "notifications/initialized") {
        return jsonResponse({});
      }
      return jsonResponse({
        id: 2,
        jsonrpc: "2.0",
        result: {
          content: [
            { text: '{"success":true,"rows":[{"n":1}]}', type: "text" },
          ],
        },
      });
    }) as typeof fetch;
    try {
      const context = {
        abortSignal: new AbortController().signal,
        getToken: () => Promise.resolve({ token: "t" }),
        requireAuth: () => undefined,
      } as unknown as Parameters<typeof tool.execute>[1];
      await tool.execute({ query: "SELECT 1" }, context);
    } finally {
      globalThis.fetch = original;
    }
    const call = calls.find((c) => c.method === "tools/call") as {
      params: { arguments: unknown };
    };
    assert.deepEqual(call.params.arguments, {
      ...PRODUCTION_READ_QUERY_ARGS,
      query: "SELECT 1",
    });
  });
});
