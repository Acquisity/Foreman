import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildReadQueryResult,
  callPlanetscaleReadQuery,
  PlanetscaleHttpError,
  parseReadQueryResult,
  truncateRows,
} from "./planetscale.js";

const NON_JSON_ERROR = /non-JSON/;
const UNRECOGNIZED_SHAPE_ERROR = /unrecognized result shape/;
const QUERY_FAILED_ERROR = /query failed/;
const SYNTAX_ERROR = /syntax error/;
const NOTIFICATION_FAILED_ERROR = /notifications\/initialized failed/;
const NO_RESULT_ERROR = /no JSON-RPC result/;
const INVALID_TOKEN_ERROR = /invalid token/;

describe("truncateRows", () => {
  it("keeps every row when the total is under the cap", () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = truncateRows(rows, 1024);
    assert.equal(result.truncated, false);
    assert.equal(result.totalRows, 3);
    assert.equal(result.returnedRows, 3);
    assert.deepEqual(result.rows, rows);
    // [{"id":1},{"id":2},{"id":3}] = 2 brackets + 3*8 + 2 commas.
    assert.equal(result.resultBytes, 28);
  });

  it("drops rows once the cap would be exceeded", () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    // Each row is 8 bytes; the array adds 2 brackets and a comma per pair.
    // [{"id":1}] is 10 bytes, [{"id":1},{"id":2}] is 19 bytes.
    const result = truncateRows(rows, 18);
    assert.equal(result.truncated, true);
    assert.equal(result.totalRows, 3);
    assert.equal(result.returnedRows, 1);
    assert.deepEqual(result.rows, [{ id: 1 }]);
    assert.equal(result.resultBytes, 10);
  });

  it("returns an empty result for an empty input", () => {
    const result = truncateRows([], 1024);
    assert.deepEqual(result.rows, []);
    assert.equal(result.truncated, false);
    assert.equal(result.totalRows, 0);
    assert.equal(result.returnedRows, 0);
    assert.equal(result.resultBytes, 2);
    assert.equal(result.oversizedRow, false);
    assert.equal(result.envelopeTooLarge, false);
  });

  it("measures byte length, not character length", () => {
    // "é" is two UTF-8 bytes, so the cap must account for that.
    const rows = [{ name: "é" }];
    const result = truncateRows(rows, 1024);
    assert.equal(
      result.resultBytes,
      Buffer.byteLength('[{"name":"é"}]', "utf8")
    );
    assert.equal(result.truncated, false);
  });

  it("accounts for overhead bytes in the budget", () => {
    const rows = [{ id: 1 }, { id: 2 }];
    // Without overhead, cap 19 fits both rows (19 bytes).
    assert.equal(truncateRows(rows, 19).returnedRows, 2);
    // One byte of overhead shrinks the budget enough to keep only one row.
    assert.equal(truncateRows(rows, 19, 1).returnedRows, 1);
  });

  it("flags a single row that alone exceeds the cap", () => {
    const result = truncateRows([{ blob: "x".repeat(100) }], 10);
    assert.equal(result.oversizedRow, true);
    assert.equal(result.returnedRows, 0);
    assert.deepEqual(result.rows, []);
    assert.equal(result.truncated, true);
    assert.equal(result.totalRows, 1);
  });

  it("keeps the serialized rows array under the cap for many small rows", () => {
    // Small rows are the worst case: the commas between rows dominate the
    // payload, so this is the regression the ticket is about.
    const rows = Array.from({ length: 3_000_000 }, (_, i) => i % 1000);
    const capBytes = 8 * 1024 * 1024;
    const overheadBytes = 500;
    const result = truncateRows(rows, capBytes, overheadBytes);
    assert.ok(result.resultBytes <= capBytes - overheadBytes);
    assert.equal(
      Buffer.byteLength(JSON.stringify(result.rows), "utf8"),
      result.resultBytes
    );
    assert.equal(result.truncated, true);
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

    // The session id and protocol version are echoed on post-initialize requests.
    assert.equal(calls[0].headers.get("mcp-session-id"), null);
    assert.equal(calls[1].headers.get("mcp-session-id"), "session-abc");
    assert.equal(calls[2].headers.get("mcp-session-id"), "session-abc");
    assert.equal(calls[1].headers.get("MCP-Protocol-Version"), "2025-06-18");
    assert.equal(calls[2].headers.get("MCP-Protocol-Version"), "2025-06-18");

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

  it("throws when tools/call returns a JSON-RPC error", async () => {
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

  it("throws with the server's error text when the tool reports isError", async () => {
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
          id: 2,
          jsonrpc: "2.0",
          result: {
            content: [
              { text: 'syntax error at or near "SELEC"', type: "text" },
            ],
            isError: true,
          },
        });
      }
      throw new Error(`Unexpected method: ${body.method}`);
    };

    await assert.rejects(
      callPlanetscaleReadQuery(
        "secret-token",
        { query: "SELEC 1" },
        { fetch: fetchStub }
      ),
      SYNTAX_ERROR
    );
  });
});

describe("envelopeTooLarge", () => {
  it("flags when the overhead alone exceeds the cap", () => {
    const result = truncateRows([{ id: 1 }], 10, 20);
    assert.equal(result.envelopeTooLarge, true);
    assert.equal(result.oversizedRow, false);
    assert.deepEqual(result.rows, []);
    assert.equal(result.truncated, true);
    assert.equal(result.totalRows, 1);
  });
});

describe("buildReadQueryResult", () => {
  it("keeps the full returned object under the stream limit at the cap", () => {
    const rows = Array.from({ length: 3_000_000 }, (_, i) => i % 1000);
    const result = buildReadQueryResult(rows, {}, 1024 * 1024);
    const serialized = Buffer.byteLength(JSON.stringify(result), "utf8");
    assert.ok(serialized < 10_485_760);
    assert.equal(result.truncated, true);
  });

  it("preserves passthrough fields and wins on metadata collisions", () => {
    const result = buildReadQueryResult(
      [{ id: 1 }],
      { columns: ["id"], truncated: "server-says-no" },
      1024 * 1024
    );
    assert.equal(result.truncated, false);
    assert.equal(result.success, true);
    assert.deepEqual(result.columns, ["id"]);
  });
});

describe("PlanetscaleHttpError", () => {
  it("carries the HTTP status for re-auth mapping", async () => {
    const fetchStub: typeof fetch = (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "initialize") {
        return Promise.resolve(
          new Response(JSON.stringify({}), { status: 401 })
        );
      }
      throw new Error("unreachable");
    };
    await assert.rejects(
      callPlanetscaleReadQuery(
        "secret-token",
        { query: "SELECT 1" },
        { fetch: fetchStub }
      ),
      (error) => {
        assert.ok(error instanceof PlanetscaleHttpError);
        assert.equal(error.status, 401);
        return true;
      }
    );
  });

  it("checks the notifications/initialized status", async () => {
    const fetchStub: typeof fetch = (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "initialize") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 1,
              jsonrpc: "2.0",
              result: { protocolVersion: "2025-06-18" },
            }),
            { headers: { "Content-Type": "application/json" }, status: 200 }
          )
        );
      }
      if (body.method === "notifications/initialized") {
        return Promise.resolve(new Response("", { status: 500 }));
      }
      throw new Error("unreachable");
    };
    await assert.rejects(
      callPlanetscaleReadQuery(
        "secret-token",
        { query: "SELECT 1" },
        { fetch: fetchStub }
      ),
      NOTIFICATION_FAILED_ERROR
    );
  });
});

describe("HTTP failure paths", () => {
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

  it("includes a bounded body slice in a tools/call HTTP failure", async () => {
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
        return Promise.resolve(new Response("invalid token", { status: 403 }));
      }
      throw new Error("unreachable");
    };
    await assert.rejects(
      callPlanetscaleReadQuery(
        "secret-token",
        { query: "SELECT 1" },
        { fetch: fetchStub }
      ),
      (error) => {
        assert.ok(error instanceof PlanetscaleHttpError);
        assert.equal(error.status, 403);
        assert.match(error.message, INVALID_TOKEN_ERROR);
        return true;
      }
    );
  });

  it("throws when the response carries no JSON-RPC result", async () => {
    const fetchStub: typeof fetch = (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "initialize") {
        return Promise.resolve(
          new Response("not a json-rpc response", { status: 200 })
        );
      }
      throw new Error("unreachable");
    };
    await assert.rejects(
      callPlanetscaleReadQuery(
        "secret-token",
        { query: "SELECT 1" },
        { fetch: fetchStub }
      ),
      NO_RESULT_ERROR
    );
  });
});
