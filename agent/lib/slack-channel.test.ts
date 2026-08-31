import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Session } from "eve/channels";
import type {
  SlackEventContext,
  SlackInboundMessageContext,
  SlackMessage,
} from "eve/channels/slack";
import type { MessageStreamEvent } from "eve/client";

// Connector variables the channel module requires at evaluation time.
// Nothing here is contacted; the values only have to exist.
const ENV_ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=/u;
const UUID_V5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
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

const inboundContext = (
  session: Session | undefined,
  posts: string[] = [],
  postedIds = new Set<string>(),
  requests: unknown[] = [],
  requestOverride?: (
    operation: string,
    body: Record<string, unknown>
  ) => Promise<{ ok: boolean }>
) =>
  ({
    resolveSession: () => Promise.resolve(session),
    slack: {
      channelId: "C0DEV",
      request: (operation: string, body: Record<string, unknown>) => {
        requests.push({ body, operation });
        if (requestOverride) {
          return requestOverride(operation, body);
        }
        const clientMessageId = body.client_msg_id;
        if (
          typeof clientMessageId === "string" &&
          !postedIds.has(clientMessageId)
        ) {
          postedIds.add(clientMessageId);
          posts.push(String(body.text));
        }
        return Promise.resolve({ ok: true });
      },
      teamId: "T123",
      threadTs: "1700000000.000100",
    },
  }) as unknown as SlackInboundMessageContext;

const streamEvent = (
  type: MessageStreamEvent["type"],
  turnId?: string
): MessageStreamEvent =>
  ({
    data:
      type === "session.waiting"
        ? { continuationToken: "thread", wait: "next-user-message" }
        : { sequence: 1, turnId },
    meta: { at: "2026-08-31T12:00:00.000Z", id: `evt_${type}` },
    type,
  }) as MessageStreamEvent;

const eventStream = (
  events: readonly MessageStreamEvent[]
): ReadableStream<MessageStreamEvent> =>
  new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(event);
      }
      controller.close();
    },
  });

const cancellableSession = (
  snapshot: readonly MessageStreamEvent[],
  confirmation: readonly MessageStreamEvent[],
  calls: unknown[]
): Session =>
  ({
    cancel: (options?: { turnId?: string }) => {
      calls.push(options);
      return Promise.resolve({ sessionId: "s1", status: "accepted" });
    },
    getEventStream: ({ startIndex = 0 } = {}) =>
      Promise.resolve(eventStream(startIndex === 0 ? snapshot : confirmation)),
    getStreamTailIndex: () => Promise.resolve(snapshot.length - 1),
    id: "s1",
  }) as unknown as Session;

const cancellableSessionWithConfirmationStream = (
  snapshot: readonly MessageStreamEvent[],
  confirmation: ReadableStream<MessageStreamEvent>,
  calls: unknown[],
  onCancel: () => void
): Session =>
  ({
    cancel: (options?: { turnId?: string }) => {
      calls.push(options);
      onCancel();
      return Promise.resolve({ sessionId: "s1", status: "accepted" });
    },
    getEventStream: ({ startIndex = 0 } = {}) =>
      Promise.resolve(startIndex === 0 ? eventStream(snapshot) : confirmation),
    getStreamTailIndex: () => Promise.resolve(snapshot.length - 1),
    id: "s1",
  }) as unknown as Session;

describe("slack channel", () => {
  it("is discovered with the queue turn policy so follow-ups wait", () => {
    assert.equal(channel.turnPolicy, "queue");
    assert.ok(channel.routes.length > 0);
  });

  it("cancels the active turn and consumes a literal stop", async () => {
    const calls: unknown[] = [];
    const posts: string[] = [];
    const session = cancellableSession(
      [streamEvent("turn.started", "t1")],
      [streamEvent("turn.cancelled", "t1")],
      calls
    );
    const result = await dispatch(
      inboundContext(session, posts),
      message("stop")
    );
    assert.equal(result, null);
    assert.deepEqual(calls, [{ turnId: "t1" }]);
    assert.deepEqual(posts, ["Stopped."]);
  });

  it("accepts a mention and terminal punctuation around cancel", async () => {
    const calls: unknown[] = [];
    const session = cancellableSession(
      [streamEvent("turn.started", "t1")],
      [streamEvent("turn.cancelled", "t1")],
      calls
    );
    const result = await dispatch(
      inboundContext(session),
      message("<@U999>  Cancel!!")
    );
    assert.equal(result, null);
    assert.deepEqual(calls, [{ turnId: "t1" }]);
  });

  it("deduplicates confirmations for concurrent stops across handlers", async () => {
    const calls: unknown[] = [];
    const posts: string[] = [];
    const postedIds = new Set<string>();
    const requests: Array<{
      body: Record<string, unknown>;
      operation: string;
    }> = [];
    const session = cancellableSession(
      [streamEvent("turn.started", "t1")],
      [streamEvent("turn.cancelled", "t1")],
      calls
    );
    await Promise.all([
      dispatch(
        inboundContext(session, posts, postedIds, requests),
        message("stop")
      ),
      dispatch(
        inboundContext(session, posts, postedIds, requests),
        message("cancel")
      ),
    ]);
    assert.equal(calls.length, 2);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.operation, "chat.postMessage");
    assert.equal(
      requests[0]?.body.client_msg_id,
      requests[1]?.body.client_msg_id
    );
    assert.match(String(requests[0]?.body.client_msg_id), UUID_V5);
    assert.deepEqual(posts, ["Stopped."]);
  });

  it("keeps a completed stop successful when confirmation delivery fails", async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    const requestOutcomes = [
      () => Promise.resolve({ ok: false }),
      () => Promise.reject(new Error("provider response must stay private")),
    ];
    const results = await Promise.all(
      requestOutcomes.map((requestOverride) => {
        const session = cancellableSession(
          [streamEvent("turn.started", "t1")],
          [streamEvent("turn.cancelled", "t1")],
          []
        );
        return dispatch(
          inboundContext(session, [], new Set<string>(), [], requestOverride),
          message("stop")
        );
      })
    );
    assert.deepEqual(results, [null, null]);
    assert.deepEqual(warnings, [
      "Slack stop confirmation could not be posted.",
      "Slack stop confirmation could not be posted.",
    ]);
    assert.equal(warnings.join(" ").includes("provider response"), false);
  });

  it("stays quiet when an accepted session is already parked", async () => {
    const calls: unknown[] = [];
    const posts: string[] = [];
    const session = cancellableSession(
      [
        streamEvent("turn.started", "t1"),
        streamEvent("turn.completed", "t1"),
        streamEvent("session.waiting"),
      ],
      [],
      calls
    );
    const result = await dispatch(
      inboundContext(session, posts),
      message("stop")
    );
    assert.equal(result, null);
    assert.deepEqual(calls, []);
    assert.deepEqual(posts, []);
  });

  it("stays quiet when the observed turn completes before cancellation", async () => {
    const calls: unknown[] = [];
    const posts: string[] = [];
    const session = cancellableSession(
      [streamEvent("turn.started", "t1")],
      [streamEvent("turn.completed", "t1"), streamEvent("session.waiting")],
      calls
    );
    const result = await dispatch(
      inboundContext(session, posts),
      message("stop")
    );
    assert.equal(result, null);
    assert.deepEqual(calls, [{ turnId: "t1" }]);
    assert.deepEqual(posts, []);
  });

  it("bounds cancellation confirmation and closes a stalled stream", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const calls: unknown[] = [];
    const posts: string[] = [];
    let streamCancelled = false;
    let cancellationRequested: (() => void) | undefined;
    const cancellationStarted = new Promise<void>((resolve) => {
      cancellationRequested = resolve;
    });
    const confirmation = new ReadableStream<MessageStreamEvent>({
      cancel() {
        streamCancelled = true;
      },
    });
    const session = cancellableSessionWithConfirmationStream(
      [streamEvent("turn.started", "t1")],
      confirmation,
      calls,
      () => cancellationRequested?.()
    );

    const pendingDispatch = dispatch(
      inboundContext(session, posts),
      message("stop")
    );
    await cancellationStarted;
    await Promise.resolve();
    t.mock.timers.tick(10_000);

    assert.equal(await pendingDispatch, null);
    assert.deepEqual(calls, [{ turnId: "t1" }]);
    assert.deepEqual(posts, []);
    assert.equal(streamCancelled, true);
  });

  it("stays quiet when the Slack thread has no session owner", async () => {
    const posts: string[] = [];
    const result = await dispatch(
      inboundContext(undefined, posts),
      message("stop")
    );
    assert.equal(result, null);
    assert.deepEqual(posts, []);
  });

  it("never lets an authorless event cancel work", async () => {
    const authorless = { ...message("stop"), author: undefined };
    const result = await dispatch(inboundContext(undefined), authorless);
    assert.equal(result, null);
  });

  it("delivers a longer request that merely starts with stop", async () => {
    const result = await dispatch(
      inboundContext(undefined),
      message("stop the deploy")
    );
    assert.ok(result && "auth" in result && result.auth);
  });

  it("does not attribute an unrelated cooperative cancellation to stop", () => {
    const handler = slackChannelEvents["turn.cancelled"];
    assert.equal(handler, undefined);
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
