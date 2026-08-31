import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Session } from "eve/channels";
import type {
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
  requests: unknown[] = []
) =>
  ({
    resolveSession: () => Promise.resolve(session),
    slack: {
      channelId: "C0DEV",
      request: (operation: string, body: Record<string, unknown>) => {
        requests.push({ body, operation });
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
});
