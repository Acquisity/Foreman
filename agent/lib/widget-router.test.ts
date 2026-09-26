import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  asksForChange,
  DECISION_CONTEXT,
  offersRecording,
  renderAsk,
  routeWidgetMessage,
} from "./widget-router.js";

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
      continuesSteps: 0,
      explainsPrevious: 0,
      followUp: 0,
      kbScore: 0,
      lane: "investigate",
      returnsToEarlierAsk: 0,
      source: "jev",
      unclear: 0,
    });
    assert.ok(sent, "should have called Jev");
    const body = JSON.parse((sent as { body: string }).body);
    assert.equal(body.state, "why did my campaign stop?");
    assert.deepEqual(Object.keys(body.questions).sort(), [
      "asks_for_action",
      "asks_for_human",
      "asks_for_refund",
      "asks_for_ticket",
      "asks_own_data",
      "continues_steps",
      "depends_on_previous",
      "explains_previous",
      "is_unclear",
      "lane",
      "offers_recording",
      "reports_bug",
      "returns_to_earlier_ask",
    ]);
    assert.equal(
      (sent as { headers: Record<string, string> }).headers.authorization,
      "Bearer test-key"
    );
  });

  it("reports whether the message goes back to an earlier request and whether it continues the previous reply's steps", async () => {
    const route = await routeWidgetMessage("ok im here. now what?", {
      apiKey: "test-key",
      fetch: () =>
        Promise.resolve({
          json: () =>
            Promise.resolve({
              answers: {
                asks_for_human: { noul: 0.04 },
                asks_own_data: { noul: 0.3 },
                continues_steps: { noul: 0.76 },
                lane: { choice: "kb", confidence: 0.9 },
                returns_to_earlier_ask: { noul: 0.81 },
              },
            }),
          ok: true,
          status: 200,
        }),
    });
    assert.equal(route.continuesSteps, 0.76);
    assert.equal(route.returnsToEarlierAsk, 0.81);
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

  it("investigates a request for a ticket whatever else it looks like", async () => {
    // Measured on "can you please open up a tech ticket for me": action 0.86.
    const route = await routeWidgetMessage("please open a tech ticket", {
      apiKey: "test-key",
      fetch: () =>
        Promise.resolve({
          json: () =>
            Promise.resolve({
              answers: {
                asks_for_action: { noul: 0.86 },
                asks_for_human: { noul: 0.16 },
                asks_for_ticket: { noul: 0.95 },
                asks_own_data: { noul: 0.95 },
                is_unclear: { noul: 0.9 },
                lane: {
                  choice: "kb",
                  confidence: 0.9,
                  probabilities: { kb: 0.9 },
                },
              },
            }),
          ok: true,
          status: 200,
        }),
    });
    assert.equal(route.lane, "investigate");
    assert.equal(route.asksForAction, 0);
    assert.equal(route.kbScore, 0);
    assert.equal(route.unclear, 0);
  });

  it("flags a bug report on any lane, including a ticket request", async () => {
    const bugReply = (extra: Record<string, unknown>, bug: number) => () =>
      Promise.resolve({
        json: () =>
          Promise.resolve({
            answers: {
              asks_for_human: { noul: 0.04 },
              asks_own_data: { noul: 0.9 },
              lane: { choice: "investigate", confidence: 0.8 },
              reports_bug: { noul: bug },
              ...extra,
            },
          }),
        ok: true,
        status: 200,
      });
    const plain = await routeWidgetMessage("the save button does nothing", {
      apiKey: "test-key",
      fetch: bugReply({}, 0.9),
    });
    assert.equal(plain.bug, true);
    assert.equal(plain.lane, "investigate");
    const ticket = await routeWidgetMessage("report this bug please", {
      apiKey: "test-key",
      fetch: bugReply({ asks_for_ticket: { noul: 0.9 } }, 0.9),
    });
    assert.equal(ticket.ticket, true);
    assert.equal(ticket.bug, true);
    const howTo = await routeWidgetMessage("how do I add an inbox?", {
      apiKey: "test-key",
      fetch: bugReply({}, 0.2),
    });
    assert.equal(howTo.bug, undefined);
  });

  it("flags an ask or offer to send a recording when Jev says so, typos included", async () => {
    const recordingReply = (offers: number) => () =>
      Promise.resolve({
        json: () =>
          Promise.resolve({
            answers: {
              asks_for_human: { noul: 0.04 },
              asks_own_data: { noul: 0.2 },
              lane: { choice: "kb", confidence: 0.8 },
              offers_recording: { noul: offers },
              reports_bug: { noul: 0.1 },
            },
          }),
        ok: true,
        status: 200,
      });
    const message = "i found a bug can i send a screen reco0rding";
    const asked = await routeWidgetMessage(message, {
      apiKey: "test-key",
      fetch: recordingReply(0.96),
    });
    assert.equal(asked.recording, true);
    assert.equal(asked.lane, "kb");
    const notAsked = await routeWidgetMessage(
      "how do I record a video in the app builder",
      { apiKey: "test-key", fetch: recordingReply(0.25) }
    );
    assert.equal(notAsked.recording, undefined);
  });

  it("investigates a refund request as a ticket, unless the customer asked for a person", async () => {
    const refund = (human: number) =>
      routeWidgetMessage("can I get a refund?", {
        apiKey: "test-key",
        fetch: () =>
          Promise.resolve({
            json: () =>
              Promise.resolve({
                answers: {
                  asks_for_action: { noul: 0.9 },
                  asks_for_human: { noul: human },
                  asks_for_refund: { noul: 0.93 },
                  asks_own_data: { noul: 0.6 },
                  is_unclear: { noul: 0.85 },
                  lane: { choice: "kb", confidence: 0.7 },
                },
              }),
            ok: true,
            status: 200,
          }),
      });
    const route = await refund(0.1);
    assert.equal(route.lane, "investigate");
    assert.equal(route.refund, true);
    assert.equal(route.ticket, true);
    assert.equal(route.asksForAction, 0);
    assert.equal(route.kbScore, 0);
    assert.equal(route.unclear, 0);
    const person = await refund(0.95);
    assert.equal(person.refund, undefined);
    assert.equal(person.ticket, undefined);
  });

  it("hands off only when the direct question agrees a person was asked for", async () => {
    // Measured on "can you open up a ticket for me please": lane human at 0.96
    // while asks_for_human scored 0.14.
    const route = await routeWidgetMessage("can you open up a ticket for me", {
      apiKey: "test-key",
      fetch: () => Promise.resolve(jevReply("human", 0.96)),
    });
    assert.equal(route.lane, "investigate");
    const agreed = await routeWidgetMessage("let me talk to a person", {
      apiKey: "test-key",
      fetch: () =>
        Promise.resolve({
          json: () =>
            Promise.resolve({
              answers: {
                asks_for_human: { noul: 0.97 },
                asks_own_data: { noul: 0.1 },
                lane: { choice: "human", confidence: 0.95 },
              },
            }),
          ok: true,
          status: 200,
        }),
    });
    assert.equal(agreed.lane, "human");
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

  it("puts the latest message first and apart from a few bounded earlier turns", async () => {
    const turns = Array.from({ length: 10 }, (_, n) => ({
      role: n % 2 ? ("assistant" as const) : ("customer" as const),
      text: `turn ${n} ${"x".repeat(2000)}`,
    }));
    const state = renderAsk({ latest: "okay, what next?", turns });
    assert.ok(state.startsWith("LATEST CUSTOMER MESSAGE"));
    assert.ok(state.indexOf("okay, what next?") < state.indexOf("turn 6"));
    assert.ok(
      !state.includes("turn 5"),
      "only the most recent turns ride along"
    );
    assert.ok(state.length < 2500);
    assert.equal(renderAsk("hello"), "hello");

    let sent = "";
    const route = await routeWidgetMessage(
      { latest: "okay, what next?", turns },
      {
        apiKey: "test-key",
        fetch: (_url, init) => {
          sent = JSON.parse(init.body).state;
          return Promise.resolve({
            json: () =>
              Promise.resolve({
                answers: {
                  asks_for_human: { noul: 0 },
                  asks_own_data: { noul: 0.1 },
                  depends_on_previous: { noul: 0.93 },
                  lane: { choice: "kb", confidence: 0.8 },
                },
              }),
            ok: true,
            status: 200,
          });
        },
      }
    );
    // The router decides on the full shared context, not the short reply one.
    assert.equal(
      sent,
      renderAsk({ latest: "okay, what next?", turns }, DECISION_CONTEXT)
    );
    assert.equal(route.followUp, 0.93);
  });
});

describe("low-confidence human routing regression", () => {
  it("keeps a feature-navigation question in the help-center lane", async () => {
    const route = await routeWidgetMessage(
      "canh you tell me where to find the niche researcher?",
      {
        apiKey: "test-key",
        fetch: () =>
          Promise.resolve({
            json: async () => ({
              answers: {
                asks_for_human: { noul: 0.55 },
                asks_own_data: { noul: 0.19 },
                lane: {
                  choice: "human",
                  confidence: 0.37,
                  probabilities: { human: 0.37, investigate: 0.19, kb: 0.43 },
                },
              },
            }),
            ok: true,
            status: 200,
          }),
      }
    );
    assert.equal(route.lane, "kb");
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
