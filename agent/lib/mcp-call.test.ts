import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callMcpTool, McpHttpError } from "./mcp-call.js";

const REDACTED = /\[redacted\]/u;

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

  it("never echoes the bearer token or an inline secret in an error", async () => {
    const token = "sk-live-sentinel-0123456789abcdef";
    const echo = `unauthorized: got Bearer ${token} for api_key=${token}`;
    await assert.rejects(
      call(
        stub(() => Promise.resolve(new Response(echo, { status: 401 }))),
        token
      ),
      (error: unknown) => {
        assert.ok(error instanceof McpHttpError);
        assert.equal(error.status, 401);
        assert.ok(!error.message.includes(token), "token stripped");
        assert.match(error.message, REDACTED);
        return true;
      }
    );
    await assert.rejects(
      call(
        stub(() =>
          jsonResponse({
            id: 2,
            jsonrpc: "2.0",
            result: {
              content: [{ text: `bad request for ${token}`, type: "text" }],
              isError: true,
            },
          })
        ),
        token
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(token), "token stripped");
        return true;
      }
    );
  });

  it("sends the negotiated protocol version after initialize", async () => {
    const versions: string[] = [];
    const fetchStub: typeof fetch = (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      const headers = init?.headers as Record<string, string | undefined>;
      if (body.method === "initialize") {
        return jsonResponse({
          id: 1,
          jsonrpc: "2.0",
          result: { protocolVersion: "2025-03-26" },
        });
      }
      versions.push(headers["MCP-Protocol-Version"] ?? "");
      if (body.method === "notifications/initialized") {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      return jsonResponse({
        id: 2,
        jsonrpc: "2.0",
        result: { content: [{ text: "ok", type: "text" }] },
      });
    };
    assert.equal(await call(fetchStub), "ok");
    assert.deepEqual(versions, ["2025-03-26", "2025-03-26"]);
  });
});
