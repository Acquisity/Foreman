import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  SlackEventContext,
  SlackInboundMessageContext,
  SlackMessage,
} from "eve/channels/slack";
import { FINAL_SLACK_POST_RULE } from "./slack-intake.js";

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
    assert.deepEqual(result?.context, [FINAL_SLACK_POST_RULE]);
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

  const completedEventChannel = (calls: string[]) =>
    ({
      state: {},
      thread: {
        post: (text: string) => {
          calls.push(`post:${text}`);
          return Promise.resolve();
        },
        startTyping: () => {
          calls.push("typing");
          return Promise.resolve();
        },
      },
    }) as unknown as SlackEventContext;

  const completed = (
    finishReason: "stop" | "tool-calls",
    text: string | null
  ) => ({
    finishReason,
    message: text,
    sequence: 1,
    stepIndex: 0,
    turnId: "t1",
  });

  it("posts the complete final message verbatim", async () => {
    const handler = slackChannelEvents["message.completed"];
    assert.ok(handler);
    const calls: string[] = [];
    // The retired marker is now ordinary content: nothing splits the post.
    // Joined so the marker-removal scan below never matches this source.
    const marker = ["---", "reply", "---"].join("");
    const full = `\n  All of this posts, indentation included.\n${marker}\nEven this line.\n\n`;
    await handler(
      completed("stop", full),
      completedEventChannel(calls),
      {} as never
    );
    assert.deepEqual(calls, [`post:${full}`]);
  });

  it("starts typing instead of posting an empty final message", async () => {
    const handler = slackChannelEvents["message.completed"];
    assert.ok(handler);
    const calls: string[] = [];
    await handler(
      completed("stop", "  \n"),
      completedEventChannel(calls),
      {} as never
    );
    assert.deepEqual(calls, ["typing"]);
  });

  it("keeps tool-call narration out of the thread", async () => {
    const handler = slackChannelEvents["message.completed"];
    assert.ok(handler);
    const calls: string[] = [];
    const eventChannel = completedEventChannel(calls);
    await handler(
      completed("tool-calls", "Checking Stripe now."),
      eventChannel,
      {} as never
    );
    assert.deepEqual(calls, []);
    assert.equal(
      eventChannel.state.pendingToolCallMessage,
      "Checking Stripe now."
    );
  });
});

// Joined so this suite's own source never matches the needle.
const RETIRED_REPLY_MARKER = ["---", "reply", "---"].join("");

const collectFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? collectFiles(path) : [path];
  });

describe("retired reply marker", () => {
  it("appears nowhere under agent/", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const offenders = collectFiles(root).filter((file) =>
      readFileSync(file, "utf8").includes(RETIRED_REPLY_MARKER)
    );
    assert.deepEqual(offenders, []);
  });
});
