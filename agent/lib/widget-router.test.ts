import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeWidgetMessage } from "./widget-router.js";

const jevReply = (lane: string, confidence: number) => ({
  json: () =>
    Promise.resolve({
      answers: {
        asks_for_human: { noul: 0.04 },
        asks_own_data: { noul: 0.91 },
        lane: { choice: lane, confidence, probabilities: { [lane]: 0.9 } },
      },
      model: "jev-latest",
    }),
  ok: true,
  status: 200,
});

describe("routeWidgetMessage", () => {
  it("maps a Jev answer onto a lane with its confidence", async () => {
    let sent: { body: string; headers: Record<string, string> } | null = null;
    const route = await routeWidgetMessage("why did my campaign stop?", {
      apiKey: "test-key",
      fetch: (_url, init) => {
        sent = init;
        return Promise.resolve(jevReply("investigate", 0.87));
      },
    });
    assert.deepEqual(route, {
      asksForHuman: 0.04,
      asksOwnData: 0.91,
      confidence: 0.87,
      lane: "investigate",
      source: "jev",
    });
    assert.ok(sent, "should have called Jev");
    const body = JSON.parse((sent as { body: string }).body);
    assert.equal(body.state, "why did my campaign stop?");
    assert.deepEqual(Object.keys(body.questions).sort(), [
      "asks_for_human",
      "asks_own_data",
      "lane",
    ]);
    assert.equal(
      (sent as { headers: Record<string, string> }).headers.authorization,
      "Bearer test-key"
    );
  });

  it("falls open to investigate without a key and never calls out", async () => {
    let called = false;
    const route = await routeWidgetMessage("hello", {
      apiKey: "",
      fetch: () => {
        called = true;
        return Promise.resolve(jevReply("kb", 0.99));
      },
    });
    assert.equal(route.lane, "investigate");
    assert.equal(route.source, "fallback");
    assert.equal(called, false);
  });

  it("falls open on a network error, a bad status, and a malformed body", async () => {
    const failures = [
      () => Promise.reject(new Error("boom")),
      () =>
        Promise.resolve({
          json: () => Promise.resolve({}),
          ok: false,
          status: 500,
        }),
      () =>
        Promise.resolve({
          json: () => Promise.resolve({ answers: { lane: { choice: "??" } } }),
          ok: true,
          status: 200,
        }),
    ];
    const routes = await Promise.all(
      failures.map((fetchImpl) =>
        routeWidgetMessage("hello", { apiKey: "test-key", fetch: fetchImpl })
      )
    );
    for (const route of routes) {
      assert.equal(route.lane, "investigate");
      assert.equal(route.source, "fallback");
    }
  });
});
