import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  callPlanetscaleReadQuery,
  parseReadQueryResult,
  truncateRows,
} from "./planetscale.js";

const NON_JSON_ERROR = /non-JSON/;
const UNRECOGNIZED_SHAPE_ERROR = /unrecognized result shape/;
const QUERY_FAILED_ERROR = /query failed/;

describe("truncateRows", () => {
  it("keeps every row when the total is under the cap", () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = truncateRows(rows, 1024);
    assert.equal(result.truncated, false);
    assert.equal(result.totalRows, 3);
    assert.equal(result.returnedRows, 3);
    assert.deepEqual(result.rows, rows);
    assert.equal(result.resultBytes, 24); // three `{"id":N}` of 8 bytes each
  });

  it("drops rows once the cap would be exceeded", () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    // 8 bytes per row; cap fits two rows (16) but not three (24).
    const result = truncateRows(rows, 16);
    assert.equal(result.truncated, true);
    assert.equal(result.totalRows, 3);
    assert.equal(result.returnedRows, 2);
    assert.deepEqual(result.rows, [{ id: 1 }, { id: 2 }]);
    assert.equal(result.resultBytes, 16);
  });

  it("returns an empty result for an empty input", () => {
    const result = truncateRows([], 1024);
    assert.deepEqual(result.rows, []);
    assert.equal(result.truncated, false);
    assert.equal(result.totalRows, 0);
    assert.equal(result.returnedRows, 0);
    assert.equal(result.resultBytes, 0);
  });

  it("measures byte length, not character length", () => {
    // "é" is two UTF-8 bytes, so the cap must account for that.
    const rows = [{ name: "é" }];
    const result = truncateRows(rows, 1024);
    assert.equal(result.resultBytes, Buffer.byteLength('{"name":"é"}', "utf8"));
    assert.equal(result.truncated, false);
  });
});

describe("parseReadQueryResult", () => {
  it("parses a bare JSON array into rows with no passthrough", () => {
    const result = parseReadQueryResult('[{"id":1},{"id":2}]');
    assert.deepEqual(result.rows, [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(result.passthrough, {});
  });

  it("parses an object with a rows array and preserves other fields verbatim", () => {
    const result = parseReadQueryResult(
      '{"rows":[{"id":1}],"columns":["id"],"total":1}'
    );
    assert.deepEqual(result.rows, [{ id: 1 }]);
    assert.deepEqual(result.passthrough, { columns: ["id"], total: 1 });
  });

  it("throws on non-JSON content", () => {
    assert.throws(() => parseReadQueryResult("not json"), NON_JSON_ERROR);
  });

  it("throws on an object without a rows array", () => {
    assert.throws(
      () => parseReadQueryResult('{"foo":"bar"}'),
      UNRECOGNIZED_SHAPE_ERROR
    );
  });
});

describe("callPlanetscaleReadQuery", () => {
  function jsonResponse(
    body: unknown,
    init?: { status?: number; headers?: Record<string, string> }
  ): Promise<Response> {
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json", ...init?.headers },
        status: init?.status ?? 200,
      })
    );
  }

  it("performs the initialize -> tools/call sequence and returns content text", async () => {
    const calls: Array<{
      method: string;
      body: { method?: string; params?: unknown };
      headers: Headers;
    }> = [];

    const fetchStub: typeof fetch = (_url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push({
        body,
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
      });

      if (body.method === "initialize") {
        return jsonResponse(
          {
            id: 1,
            jsonrpc: "2.0",
            result: { capabilities: {}, protocolVersion: "2025-06-18" },
          },
          { headers: { "mcp-session-id": "session-abc" } }
        );
      }
      if (body.method === "notifications/initialized") {
        return jsonResponse({});
      }
      if (body.method === "tools/call") {
        return jsonResponse({
          id: 2,
          jsonrpc: "2.0",
          result: {
            content: [
              { text: '[{"id":1},', type: "text" },
              { text: '{"id":2}]', type: "text" },
            ],
          },
        });
      }
      throw new Error(`Unexpected method: ${body.method}`);
    };

    const text = await callPlanetscaleReadQuery(
      "secret-token",
      { query: "SELECT 1" },
      { fetch: fetchStub }
    );

    assert.equal(text, '[{"id":1},{"id":2}]');
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((c) => c.body.method),
      ["initialize", "notifications/initialized", "tools/call"]
    );

    // Authorization header carries the bearer token on every request.
    for (const call of calls) {
      assert.equal(call.headers.get("Authorization"), "Bearer secret-token");
    }

    // The session id is echoed on the post-initialize requests.
    assert.equal(calls[0].headers.get("mcp-session-id"), null);
    assert.equal(calls[1].headers.get("mcp-session-id"), "session-abc");
    assert.equal(calls[2].headers.get("mcp-session-id"), "session-abc");

    // The tools/call carries the tool name and arguments verbatim.
    assert.equal(calls[2].body.method, "tools/call");
    assert.deepEqual((calls[2].body as { params: unknown }).params, {
      arguments: { query: "SELECT 1" },
      name: "planetscale_execute_read_query",
    });
  });

  it("falls back to SSE data-line extraction for the tools/call response", async () => {
    const fetchStub: typeof fetch = (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "initialize") {
        return jsonResponse({
          id: 1,
          jsonrpc: "2.0",
          result: { protocolVersion: "2025-06-18" },
        });
      }
      if (body.method === "notifications/initialized") {
        return jsonResponse({});
      }
      if (body.method === "tools/call") {
        return Promise.resolve(
          new Response(
            'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"[{\\"id\\":1}]"}]}}\n\n',
            { headers: { "Content-Type": "text/event-stream" }, status: 200 }
          )
        );
      }
      throw new Error(`Unexpected method: ${body.method}`);
    };

    const text = await callPlanetscaleReadQuery(
      "secret-token",
      { query: "SELECT 1" },
      { fetch: fetchStub }
    );
    assert.equal(text, '[{"id":1}]');
  });

  it("throws when tools/call returns an error", async () => {
    const fetchStub: typeof fetch = (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "initialize") {
        return jsonResponse({
          id: 1,
          jsonrpc: "2.0",
          result: { protocolVersion: "2025-06-18" },
        });
      }
      if (body.method === "notifications/initialized") {
        return jsonResponse({});
      }
      if (body.method === "tools/call") {
        return jsonResponse({
          error: { code: -32_000, message: "query failed" },
          id: 2,
          jsonrpc: "2.0",
        });
      }
      throw new Error(`Unexpected method: ${body.method}`);
    };

    await assert.rejects(
      callPlanetscaleReadQuery(
        "secret-token",
        { query: "SELECT 1" },
        { fetch: fetchStub }
      ),
      QUERY_FAILED_ERROR
    );
  });
});
