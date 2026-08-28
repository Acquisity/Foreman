import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callMcpTool } from "./mcp-call.js";

const jsonResponse = (body: unknown, headers?: Record<string, string>) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json", ...headers },
      status: 200,
    })
  );

const call = (fetchStub: typeof fetch, token = "secret-token") =>
  callMcpTool({
    args: {},
    fetch: fetchStub,
    label: "Test MCP",
    token,
    tool: "echo",
    url: "https://mcp.example.test/mcp",
  });

/** Routes initialize and notifications/initialized; `onCall` answers tools/call. */
const stub =
  (onCall: () => Promise<Response>): typeof fetch =>
  (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    if (body.method === "initialize") {
      return jsonResponse({ id: 1, jsonrpc: "2.0", result: {} });
    }
    if (body.method === "notifications/initialized") {
      return Promise.resolve(new Response(null, { status: 202 }));
    }
    return onCall();
  };

describe("callMcpTool", () => {
  it("joins a multi-line SSE data event before parsing it", async () => {
    const result = {
      content: [{ text: "hello", type: "text" }],
    };
    const pretty = JSON.stringify({ id: 2, jsonrpc: "2.0", result }, null, 2);
    const sse = `event: message\n${pretty
      .split("\n")
      .map((line) => `data: ${line}`)
      .join("\n")}\n\n`;
    const text = await call(
      stub(() =>
        Promise.resolve(
          new Response(sse, {
            headers: { "Content-Type": "text/event-stream" },
            status: 200,
          })
        )
      )
    );
    assert.equal(text, "hello");
  });
});
