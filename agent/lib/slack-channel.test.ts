import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type {
  SlackEventContext,
  SlackInboundMessageContext,
  SlackMessage,
} from "eve/channels/slack";

// Connector variables the channel module requires at evaluation time.
// Nothing here is contacted; the values only have to exist.
const ENV_ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=/u;
for (const line of readFileSync(
  new URL("../../.env.example", import.meta.url),
  "utf8"
).split("\n")) {
  const name = ENV_ASSIGNMENT.exec(line)?.[1];
  if (name) {
    process.env[name] ??= "stub/stub";
  }
}

const {
  default: channel,
  dispatch,
  slackChannelEvents,
} = await import("../channels/slack.js");

const message = (text: string): SlackMessage => ({
  attachments: [],
  author: {
    fullName: "Aaron Fraga",
    isBot: false,
    isMe: false,
    userId: "U123",
    userName: "aaron",
  },
  channelId: "C0DEV",
  markdown: text,
  raw: {},
  teamId: "T123",
  text,
  threadTs: "1700000000.000100",
  ts: "1700000000.000200",
});

const inboundContext = (cancel: SlackInboundMessageContext["cancel"]) =>
  ({
    cancel,
    slack: { channelId: "C0DEV", threadTs: "1700000000.000100" },
  }) as unknown as SlackInboundMessageContext;

describe("slack channel", () => {
  it("is discovered with the queue turn policy so follow-ups wait", () => {
    assert.equal(channel.turnPolicy, "queue");
    assert.ok(channel.routes.length > 0);
  });

  it("cancels the active turn and consumes a literal stop", async () => {
    const calls: unknown[] = [];
    const result = await dispatch(
      inboundContext(() => {
        calls.push("cancel");
        return Promise.resolve({ sessionId: "s1", status: "accepted" });
      }),
      message("stop")
    );
    assert.equal(result, null);
    assert.deepEqual(calls, ["cancel"]);
  });

  it("accepts a mention and terminal punctuation around cancel", async () => {
    const calls: unknown[] = [];
    const result = await dispatch(
      inboundContext(() => {
        calls.push("cancel");
        return Promise.resolve({ sessionId: "s1", status: "accepted" });
      }),
      message("<@U999>  Cancel!!")
    );
    assert.equal(result, null);
    assert.deepEqual(calls, ["cancel"]);
  });

  it("stays quiet when a stop arrives with no active turn", async () => {
    const result = await dispatch(
      inboundContext(
        () => Promise.resolve({ status: "no_active_turn" }) as never
      ),
      message("stop")
    );
    assert.equal(result, null);
  });

  it("never lets an authorless event cancel work", async () => {
    let cancelled = false;
    const authorless = { ...message("stop"), author: undefined };
    const result = await dispatch(
      inboundContext(() => {
        cancelled = true;
        return Promise.resolve({ sessionId: "s1", status: "accepted" });
      }),
      authorless
    );
    assert.equal(cancelled, false);
    assert.equal(result, null);
  });

  it("delivers a longer request that merely starts with stop", async () => {
    let cancelled = false;
    const result = await dispatch(
      inboundContext(() => {
        cancelled = true;
        return Promise.resolve({ sessionId: "s1", status: "accepted" });
      }),
      message("stop the deploy")
    );
    assert.equal(cancelled, false);
    assert.ok(result && "auth" in result && result.auth);
  });

  it("posts exactly one short notice when a turn is cancelled", async () => {
    const handler = slackChannelEvents["turn.cancelled"];
    assert.ok(handler);
    const posts: string[] = [];
    const eventChannel = {
      thread: {
        post: (text: string) => {
          posts.push(text);
          return Promise.resolve();
        },
      },
    } as unknown as SlackEventContext;
    await handler({ sequence: 1, turnId: "t1" }, eventChannel, {} as never);
    assert.deepEqual(posts, ["Stopped."]);
  });
});
