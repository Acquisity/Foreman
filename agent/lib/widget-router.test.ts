import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  asksForChange,
  HUMAN_REQUEST_SCORE,
  offersRecording,
  renderAsk,
  routeWidgetMessage,
} from "./widget-router.js";

const TRAILING_MS = / ms=\d+$/;
const REFUSED_401 = /^reason=http_401 ms=\d+$/;

const jevReply = (answers: Record<string, unknown> = {}) => ({
  json: () =>
    Promise.resolve({
      answers: { asks_for_human: { noul: 0.04 }, ...answers },
      model: "jev-latest",
    }),
  ok: true,
  status: 200,
});

describe("routeWidgetMessage", () => {
  it("asks Jev what the message is, never which lane it belongs in", async () => {
    let sent: { body: string; headers: Record<string, string> } | null = null;
    const route = await routeWidgetMessage("why did my campaign stop?", {
      apiKey: "test-key",
      fetch: (_url, init) => {
        sent = init;
        return Promise.resolve(jevReply({ reports_bug: { noul: 0.2 } }));
      },
    });
    assert.deepEqual(route, { asksForHuman: 0.04, source: "jev" });
    assert.ok(sent, "should have called Jev");
    const body = JSON.parse((sent as { body: string }).body);
    assert.equal(body.state, "why did my campaign stop?");
    assert.deepEqual(Object.keys(body.questions).sort(), [
      "asks_for_human",
      "asks_for_refund",
      "asks_for_ticket",
      "offers_recording",
      "reports_bug",
    ]);
    assert.equal(
      (sent as { headers: Record<string, string> }).headers.authorization,
      "Bearer test-key"
    );
  });

  it("flags a refund, a ticket, a bug and a recording offer at their bars", async () => {
    const flagged = await routeWidgetMessage(
      "thanks! can i send a recording of the bug and get a refund",
      {
        apiKey: "test-key",
        fetch: () =>
          Promise.resolve(
            jevReply({
              asks_for_refund: { noul: 0.93 },
              asks_for_ticket: { noul: 0.6 },
              offers_recording: { noul: 0.96 },
              reports_bug: { noul: 0.9 },
            })
          ),
      }
    );
    assert.deepEqual(
      [flagged.bug, flagged.recording, flagged.refund, flagged.ticket],
      [true, true, true, true]
    );
    const below = await routeWidgetMessage(
      "how do I record a video in the app builder",
      {
        apiKey: "test-key",
        fetch: () =>
          Promise.resolve(
            jevReply({
              asks_for_refund: { noul: 0.4 },
              asks_for_ticket: { noul: 0.4 },
              offers_recording: { noul: 0.25 },
              reports_bug: { noul: 0.6 },
            })
          ),
      }
    );
    assert.deepEqual(
      [below.bug, below.recording, below.refund, below.ticket],
      [undefined, undefined, undefined, undefined]
    );
  });

  it("scores everything zero without a key and never calls out", async () => {
    let called = false;
    const route = await routeWidgetMessage("hello", {
      apiKey: "",
      fetch: () => {
        called = true;
        return Promise.resolve(jevReply());
      },
    });
    assert.deepEqual(route, { asksForHuman: 0, source: "fallback" });
    assert.equal(called, false);
  });

  it("scores everything zero on a network error, a bad status, and a malformed body", async () => {
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
          json: () => Promise.resolve({ answers: { asks_for_human: "??" } }),
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
      assert.equal(route.asksForHuman, 0);
      assert.equal(route.source, "fallback");
    }
    // The log says why, as a fixed code, after the one retry the 500 earns.
    assert.deepEqual(
      routes.map((route) => route.failure?.replace(TRAILING_MS, "")),
      ["reason=boom", "reason=http_500", "reason=invalid_output"]
    );
  });

  // 2026-09-28: TypeSafe answered 529 in about 160ms.
  it("retries once after an overloaded TypeSafe and routes on the second answer", async () => {
    const statuses = [529];
    let calls = 0;
    const route = await routeWidgetMessage("where can i buy more inboxes?", {
      apiKey: "test-key",
      fetch: () => {
        calls += 1;
        const status = statuses.shift();
        return Promise.resolve(
          status
            ? { json: () => Promise.resolve({}), ok: false, status }
            : jevReply()
        );
      },
    });
    assert.equal(calls, 2);
    assert.equal(route.source, "jev");
  });

  it("does not retry a request TypeSafe refused", async () => {
    let calls = 0;
    const route = await routeWidgetMessage("hello", {
      apiKey: "test-key",
      fetch: () => {
        calls += 1;
        return Promise.resolve({
          json: () => Promise.resolve({}),
          ok: false,
          status: 401,
        });
      },
    });
    assert.equal(calls, 1);
    assert.match(route.failure ?? "", REFUSED_401);
  });

  it("puts the latest message first and apart from a few bounded earlier turns", async () => {
    const turns = Array.from({ length: 10 }, (_, n) => ({
      role: n % 2 ? ("assistant" as const) : ("customer" as const),
      text: `turn ${n} ${"x".repeat(2000)}`,
    }));
    const state = renderAsk(
      { latest: "okay, what next?", turns },
      { chars: 1600, turnChars: 400, turns: 4 }
    );
    assert.ok(state.startsWith("LATEST CUSTOMER MESSAGE"));
    assert.ok(state.indexOf("okay, what next?") < state.indexOf("turn 6"));
    assert.ok(
      !state.includes("turn 5"),
      "only the most recent turns ride along"
    );
    assert.ok(state.length < 2500);
    assert.equal(renderAsk("hello"), "hello");

    let sent = "";
    await routeWidgetMessage(
      { latest: "okay, what next?", turns },
      {
        apiKey: "test-key",
        fetch: (_url, init) => {
          sent = JSON.parse(init.body).state;
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                answers: { asks_for_human: { noul: 0 } },
              }),
            ok: true,
            status: 200,
          });
        },
      }
    );
    // The router decides on the full shared context.
    assert.equal(sent, renderAsk({ latest: "okay, what next?", turns }));
  });
});

// Jev's asks_for_human scores, five runs each (2026-10-07). "Human agent" never
// handed off at the old 0.8 bar.
const EXPLICIT_ASKS = {
  "agent please": [0.9, 0.88, 0.9, 0.89, 0.9],
  "can I speak to a real person": [0.97, 0.97, 0.97, 0.97, 0.97],
  "get me support staff": [0.88, 0.87, 0.85, 0.86, 0.86],
  "Human agent": [0.72, 0.71, 0.72, 0.73, 0.73],
  "talk to a human": [0.94, 0.93, 0.94, 0.94, 0.94],
};
const MENTIONS_A_PERSON = {
  "is a human reviewing my campaigns?": [0.45, 0.39, 0.39, 0.43, 0.43],
  "my human SDR quit": [0.31, 0.31, 0.31, 0.33, 0.33],
  "thanks, you're better than a human": [0.12, 0.11, 0.11, 0.14, 0.13],
  "this is useless": [0.17, 0.19, 0.19, 0.2, 0.21],
};

describe("HUMAN_REQUEST_SCORE", () => {
  it("hands off every measured explicit ask for a person and none of the messages that only mention one", () => {
    for (const scores of Object.values(EXPLICIT_ASKS)) {
      assert.ok(scores.every((score) => score >= HUMAN_REQUEST_SCORE));
    }
    for (const scores of Object.values(MENTIONS_A_PERSON)) {
      assert.ok(scores.every((score) => score < HUMAN_REQUEST_SCORE));
    }
  });
});

describe("asksForChange", () => {
  const reply = (noul: number) => () =>
    Promise.resolve({
      json: () => Promise.resolve({ answers: { asks_for_action: { noul } } }),
      ok: true,
      status: 200,
    });
  it("is yes only at the front door's action bar, and no on any failure", async () => {
    const convo = "can you turn my campaign back on?";
    assert.equal(
      await asksForChange(convo, { apiKey: "k", fetch: reply(0.92) }),
      true
    );
    assert.equal(
      await asksForChange(convo, { apiKey: "k", fetch: reply(0.3) }),
      false
    );
    assert.equal(await asksForChange(convo, { apiKey: "" }), false);
    assert.equal(
      await asksForChange(convo, {
        apiKey: "k",
        fetch: () => Promise.reject(new Error("down")),
      }),
      false
    );
  });
});

describe("offersRecording", () => {
  it("catches an ask or offer to send a recording", () => {
    for (const message of [
      "Can I send you a screen recording?",
      "I can screen-record it for you",
      "want me to record my screen?",
      "I'll share a quick video of what happens",
    ]) {
      assert.equal(offersRecording(message), true, message);
    }
  });

  it("ignores messages that are not about sending one", () => {
    for (const message of [
      "Why did my campaign stop sending?",
      "How do I add a video to my website?",
    ]) {
      assert.equal(offersRecording(message), false, message);
    }
  });
});
