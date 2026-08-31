import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findAiStumbles } from "./raindrop-api.js";

const UNRECOGNIZED_SHAPE_ERROR = /unrecognized result shape/u;

const jsonResponse = (body: unknown, headers?: Record<string, string>) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json", ...headers },
      status: 200,
    })
  );

const stumble = {
  created_at: "2026-08-28T09:04:04.002068+00:00",
  event_timestamp: "2026-08-28T07:49:51.086+00:00",
  id: "f61cc5b1-dace-4220-a131-7919c4fd3a21",
  project_id: "default",
  subtitle:
    "The user's questions stayed unresolved; reach them at jane@example.com",
  tags: ["Output Failure", "Instruction Following"],
  title: "Meeting setup questions received an unrelated pricing answer",
  user_review_state: "none",
};

describe("findAiStumbles", () => {
  it("sends the window and query, and maps the live response shape", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchStub: typeof fetch = (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.method === "initialize") {
        return jsonResponse(
          { id: 1, jsonrpc: "2.0", result: {} },
          { "mcp-session-id": "sess-1" }
        );
      }
      if (body.method === "notifications/initialized") {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      return jsonResponse({
        id: 2,
        jsonrpc: "2.0",
        result: {
          content: [
            {
              text: JSON.stringify({
                cadence_minutes: 30,
                count: 1,
                has_more: true,
                last_run_at: "2026-08-28T15:01:52.479+00:00",
                page: 1,
                stumbles: [stumble],
                success: true,
              }),
              type: "text",
            },
          ],
        },
      });
    };

    const result = await findAiStumbles(
      "secret-token",
      { page: 1, query: "meeting", sinceHours: 24 },
      { fetch: fetchStub, now: new Date("2026-08-28T15:16:14.149Z") }
    );

    const call = bodies.find((body) => body.method === "tools/call") as {
      params: { arguments: Record<string, unknown>; name: string };
    };
    assert.equal(call.params.name, "search_stumbles");
    assert.deepEqual(call.params.arguments, {
      created_after: "2026-08-27T15:16:14.149Z",
      page: 1,
      query: "meeting",
    });
    assert.equal(result.hasMore, true);
    assert.equal(result.cadenceMinutes, 30);
    assert.equal(result.lastRunAt, "2026-08-28T15:01:52.479+00:00");
    assert.equal(result.stumbles.length, 1);
    const [first] = result.stumbles;
    assert.equal(first?.id, stumble.id);
    assert.equal(first?.eventAt, stumble.event_timestamp);
    assert.deepEqual(first?.tags, stumble.tags);
    assert.ok(!first?.subtitle?.includes("jane@example.com"), "email redacted");
    assert.ok(JSON.stringify(result).includes("secret-token") === false);
  });

  it("rejects an unrecognized result shape", async () => {
    const fetchStub: typeof fetch = (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === "tools/call") {
        return jsonResponse({
          id: 2,
          jsonrpc: "2.0",
          result: { content: [{ text: "not json", type: "text" }] },
        });
      }
      return jsonResponse({ id: 1, jsonrpc: "2.0", result: {} });
    };
    await assert.rejects(
      findAiStumbles(
        "secret-token",
        { page: 1, sinceHours: 24 },
        { fetch: fetchStub }
      ),
      UNRECOGNIZED_SHAPE_ERROR
    );
  });
});
