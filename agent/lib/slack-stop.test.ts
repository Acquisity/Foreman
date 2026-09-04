import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SlackInboundMessageContext } from "eve/channels/slack";
import { isStopRequest, postStopNotice } from "./slack-stop.js";

describe("isStopRequest", () => {
  it("accepts the bare words stop and cancel", () => {
    assert.equal(isStopRequest("stop"), true);
    assert.equal(isStopRequest("cancel"), true);
  });

  it("ignores case and surrounding whitespace", () => {
    assert.equal(isStopRequest("STOP"), true);
    assert.equal(isStopRequest("  Cancel  "), true);
    assert.equal(isStopRequest("\nStop\n"), true);
  });

  it("accepts terminal punctuation", () => {
    assert.equal(isStopRequest("stop."), true);
    assert.equal(isStopRequest("cancel!"), true);
    assert.equal(isStopRequest("stop?!"), true);
  });

  it("accepts an optional bot mention before or after the word", () => {
    assert.equal(isStopRequest("<@U123ABC> stop"), true);
    assert.equal(isStopRequest("stop <@U123ABC>"), true);
    assert.equal(isStopRequest("<@U123ABC|foreman> cancel"), true);
    assert.equal(isStopRequest("<@U1> <@U2> stop."), true);
  });

  it("accepts punctuation after a trailing mention", () => {
    assert.equal(isStopRequest("stop <@U123>!"), true);
    assert.equal(isStopRequest("cancel <@U123>."), true);
    assert.equal(isStopRequest("<@U1> stop! <@U2>."), true);
  });

  it("rejects longer requests", () => {
    assert.equal(isStopRequest("stop the deploy"), false);
    assert.equal(isStopRequest("cancel that please"), false);
    assert.equal(isStopRequest("please stop."), false);
    assert.equal(isStopRequest("stop and then cancel"), false);
  });

  it("rejects words that merely contain stop or cancel", () => {
    assert.equal(isStopRequest("stops"), false);
    assert.equal(isStopRequest("stopping"), false);
    assert.equal(isStopRequest("cancelled"), false);
    assert.equal(isStopRequest("unstoppable"), false);
  });

  it("rejects a mention with no stop word", () => {
    assert.equal(isStopRequest("<@U123ABC>"), false);
  });

  it("rejects empty and whitespace-only input", () => {
    assert.equal(isStopRequest(""), false);
    assert.equal(isStopRequest("   \n  "), false);
  });

  it("rejects multiline requests", () => {
    assert.equal(isStopRequest("stop\nplease"), false);
  });

  it("rejects input beyond the length bound even when it would otherwise match", () => {
    const paddedButValid = `${"<@U1> ".repeat(40)}stop`;
    assert.equal(paddedButValid.length > 200, true);
    assert.equal(isStopRequest(paddedButValid), false);
  });

  it("pins the inclusive 200-character boundary with otherwise-valid input", () => {
    const exactly200 = `stop${"!".repeat(196)}`;
    const exactly201 = `stop${"!".repeat(197)}`;
    assert.equal(exactly200.length, 200);
    assert.equal(exactly201.length, 201);
    assert.equal(isStopRequest(exactly200), true);
    assert.equal(isStopRequest(exactly201), false);
  });

  it("rejects a mention embedded inside the word", () => {
    assert.equal(isStopRequest("st<@U123>op"), false);
    assert.equal(isStopRequest("s<@U1>top"), false);
    assert.equal(isStopRequest("<@U1>stop<@U2> deploy"), false);
  });
});

describe("postStopNotice", () => {
  it("keeps the legacy id stable when retrying an ambiguously accepted post", async (t) => {
    t.mock.method(console, "warn", () => undefined);
    const acceptedIds = new Set<string>();
    const attemptedIds: string[] = [];
    const posts: string[] = [];
    let loseFirstResponse = true;
    const ctx = {
      slack: {
        channelId: "C0DEV",
        request: (_operation: string, body: Record<string, unknown>) => {
          const id = String(body.client_msg_id);
          attemptedIds.push(id);
          if (!acceptedIds.has(id)) {
            acceptedIds.add(id);
            posts.push(String(body.text));
          }
          if (loseFirstResponse) {
            loseFirstResponse = false;
            return Promise.reject(new Error("response lost after acceptance"));
          }
          return Promise.resolve({ ok: true });
        },
        teamId: "T123",
        threadTs: "1700000000.000100",
      },
    } as unknown as SlackInboundMessageContext;

    await postStopNotice(ctx, "t1");
    await postStopNotice(ctx, "t1");

    assert.deepEqual(attemptedIds, [
      "03b20daa-a654-590a-8629-6e46c73043e0",
      "03b20daa-a654-590a-8629-6e46c73043e0",
    ]);
    assert.deepEqual(posts, ["Stopped."]);
  });
});
