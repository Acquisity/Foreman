import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SlackInboundMessageContext } from "eve/channels/slack";
import {
  isStopRequest,
  postStopConfirmation,
  stopSlackSession,
} from "./slack-stop.js";

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
    assert.equal(isStopRequest("stop that subagent, keep working"), false);
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

describe("postStopConfirmation", () => {
  it("keeps the retired-session id stable when retrying an ambiguously accepted post", async (t) => {
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

    await postStopConfirmation(ctx, "session-1");
    await postStopConfirmation(ctx, "session-1");

    assert.equal(attemptedIds.length, 2);
    assert.equal(attemptedIds[0], attemptedIds[1]);
    assert.deepEqual(posts, ["Stop requested."]);
  });
});

describe("stopSlackSession", () => {
  it("resets the resolved session without cancelling or scanning events", async () => {
    const requests: unknown[] = [];
    const session = {
      cancel: () =>
        assert.fail("task cancellation must not wake the parent before reset"),
      getEventStream: () => assert.fail("reset needs no turn stream"),
      getStreamTailIndex: () => assert.fail("reset needs no turn lookup"),
      id: "session-1",
      reset: (options: unknown) => {
        requests.push(options);
        return Promise.resolve({
          previousSessionId: "session-1",
          status: "reset",
        });
      },
    };
    const ctx = {
      reset: () => assert.fail("reset must use the resolved exact handle"),
      resolveSession: () => Promise.resolve(session),
    } as unknown as SlackInboundMessageContext;

    assert.equal(await stopSlackSession(ctx), "session-1");
    assert.deepEqual(requests, [{ reason: "Slack stop requested." }]);
  });

  it("does not resolve or reset a replacement owner while the exact reset awaits", async () => {
    let finishReset: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const completion = new Promise<void>((resolve) => {
      finishReset = resolve;
    });
    const requests: unknown[] = [];
    const original = {
      id: "session-original",
      reset: async (options: unknown) => {
        requests.push(options);
        markStarted?.();
        await completion;
        return { previousSessionId: "session-original", status: "reset" };
      },
    };
    let owner = original;
    let resolutions = 0;
    const ctx = {
      reset: () => assert.fail("thread-bound reset could target a replacement"),
      resolveSession: () => {
        resolutions += 1;
        return Promise.resolve(owner);
      },
    } as unknown as SlackInboundMessageContext;

    const stopping = stopSlackSession(ctx);
    await started;
    owner = {
      id: "session-replacement",
      reset: () => assert.fail("replacement session must remain untouched"),
    };
    finishReset?.();

    assert.equal(await stopping, "session-original");
    assert.equal(resolutions, 1);
    assert.deepEqual(requests, [{ reason: "Slack stop requested." }]);
    assert.equal(owner.id, "session-replacement");
  });
});
