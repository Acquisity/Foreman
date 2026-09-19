import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeWidgetMessage } from "./widget-router.js";

const jevReply = (lane: string, confidence: number) => ({
  json: () =>
    Promise.resolve({
      answers: {
        asks_for_action: { noul: 0.07 },
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
      asksForAction: 0.07,
      asksForHuman: 0.04,
      asksOwnData: 0.91,
      confidence: 0.87,
      kbScore: 0,
      lane: "investigate",
      source: "jev",
      unclear: 0,
    });
    assert.ok(sent, "should have called Jev");
    const body = JSON.parse((sent as { body: string }).body);
    assert.equal(body.state, "why did my campaign stop?");
    assert.deepEqual(Object.keys(body.questions).sort(), [
      "asks_for_action",
      "asks_for_human",
      "asks_own_data",
      "is_unclear",
      "lane",
    ]);
    assert.equal(
      (sent as { headers: Record<string, string> }).headers.authorization,
      "Bearer test-key"
    );
  });

  it("reports how likely the help center is, whichever lane won", async () => {
    const reply = (lane: object) => () =>
      Promise.resolve({
        json: () =>
          Promise.resolve({
            answers: {
              asks_for_human: { noul: 0 },
              asks_own_data: { noul: 0.8 },
              lane,
            },
          }),
        ok: true,
        status: 200,
      });
    const second = await routeWidgetMessage("when do my credits reset", {
      apiKey: "test-key",
      fetch: reply({
        choice: "investigate",
        confidence: 0.55,
        probabilities: { investigate: 0.55, kb: 0.42 },
      }),
    });
    assert.equal(second.kbScore, 0.42);
    // Without per-lane probabilities the winner's confidence stands in.
    const winner = await routeWidgetMessage("what is my dashboard for", {
      apiKey: "test-key",
      fetch: reply({ choice: "kb", confidence: 0.54 }),
    });
    assert.equal(winner.kbScore, 0.54);
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
