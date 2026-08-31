import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { Session } from "eve/channels";
import type {
  SlackChannelEvents,
  SlackEventContext,
  SlackInboundMessageContext,
  SlackMessage,
} from "eve/channels/slack";
import type { MessageStreamEvent } from "eve/client";
import { FINAL_SLACK_POST_RULE } from "./slack-intake.js";

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
    assert.deepEqual(result?.context, [FINAL_SLACK_POST_RULE]);
  });

  it("clears progress without attributing cooperative cancellation to stop", async () => {
    const handler = slackChannelEvents["turn.cancelled"];
    assert.ok(handler);
    const posts: string[] = [];
    const eventChannel = {
      state: {
        progress: {
          posts: 1,
          startedAtMs: Date.now(),
          toolCalls: 3,
          waitLabel: null,
        },
      },
      thread: {
        post: (text: string) => {
          posts.push(text);
          return Promise.resolve();
        },
      },
    } as unknown as SlackEventContext;
    await handler({ sequence: 1, turnId: "t1" }, eventChannel, {} as never);
    assert.deepEqual(posts, []);
    assert.equal(eventChannel.state.progress, undefined);
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

describe("slack channel progress", () => {
  const MINUTE_MS = 60_000;
  const T0 = 1_000_000;

  // Fake clock: the handlers read Date.now(), and each test advances `now`
  // to walk a turn across the 5- and 15-minute thresholds in order.
  const clock = (t: TestContext) => {
    let now = T0;
    t.mock.method(Date, "now", () => now);
    return {
      advance: (ms: number) => {
        now += ms;
      },
    };
  };

  const progressChannel = (
    calls: string[],
    state: Record<string, unknown> = {}
  ) =>
    ({
      slack: {
        channelId: "C0DEV",
        request: (operation: string, body: Record<string, unknown>) => {
          assert.equal(operation, "chat.postMessage");
          calls.push(`post:${String(body.text)}`);
          return Promise.resolve({ ok: true });
        },
        teamId: "T123",
        threadTs: "1700000000.000100",
      },
      state,
      thread: {
        post: (text: string) => {
          calls.push(`post:${text}`);
          return Promise.resolve();
        },
        startTyping: (status?: string) => {
          calls.push(`typing:${status ?? ""}`);
          return Promise.resolve();
        },
      },
    }) as unknown as SlackEventContext;

  const sessionWith = (auth: unknown) =>
    ({ session: { auth: { current: auth } } }) as never;

  const trustedCtx = sessionWith({ attributes: { trusted: "true" } });

  const postsOf = (calls: string[]) =>
    calls.filter((call) => call.startsWith("post:"));

  const typingsOf = (calls: string[]) =>
    calls.filter((call) => call.startsWith("typing:"));

  const handlerFor = <K extends keyof SlackChannelEvents>(key: K) => {
    const handler = slackChannelEvents[key];
    assert.ok(handler);
    return handler;
  };

  // Event fixtures use the real stream-event shapes and valid statuses.
  const turnStartedEvent = { sequence: 1, turnId: "t1" };

  const reasoningEvent = (reasoningSoFar: string) => ({
    reasoningDelta: reasoningSoFar,
    reasoningSoFar,
    sequence: 2,
    stepIndex: 0,
    turnId: "t1",
  });

  const actionsRequestedEvent = {
    actions: [
      {
        callId: "c1",
        input: { pattern: "useEveAgent" },
        kind: "tool-call",
        toolName: "grep",
      },
    ],
    sequence: 3,
    stepIndex: 0,
    turnId: "t1",
  } as const;

  const toolResultEvent = {
    result: {
      callId: "c1",
      kind: "tool-result",
      output: {},
      toolName: "grep",
    },
    sequence: 4,
    status: "completed",
    stepIndex: 0,
    turnId: "t1",
  } as const;

  // The dispatch-failure member of the subagent-result union, so the fixture
  // needs no child outcome payload; the handler reads only kind and name.
  const subagentResultEvent = {
    result: {
      callId: "c2",
      isError: true,
      kind: "subagent-result",
      origin: "dispatch",
      output: {},
      subagentName: "investigator",
    },
    sequence: 5,
    status: "failed",
    stepIndex: 0,
    turnId: "t1",
  } as const;

  const skillResultEvent = {
    result: {
      callId: "c3",
      kind: "load-skill-result",
      name: "triage-investigate",
      output: {},
    },
    sequence: 6,
    status: "completed",
    stepIndex: 0,
    turnId: "t1",
  } as const;

  const finalMessageEvent = (text: string) =>
    ({
      finishReason: "stop",
      message: text,
      sequence: 8,
      stepIndex: 1,
      turnId: "t1",
    }) as const;

  it("seeds progress state and mirrors the Working indicator on turn start", async () => {
    const handler = handlerFor("turn.started");
    const calls: string[] = [];
    const eventChannel = progressChannel(calls, {
      lastReasoningTypingAtMs: 1,
      pendingToolCallMessage: "Checking Stripe now.",
    });
    const before = Date.now();
    await handler(turnStartedEvent, eventChannel, trustedCtx);
    assert.deepEqual(calls, ["typing:Working..."]);
    assert.equal(eventChannel.state.pendingToolCallMessage, null);
    assert.equal(eventChannel.state.lastReasoningTypingAtMs, null);
    const { progress } = eventChannel.state;
    assert.ok(progress);
    assert.equal(progress.posts, 0);
    assert.equal(progress.toolCalls, 0);
    assert.equal(progress.waitLabel, null);
    assert.ok(progress.startedAtMs >= before);
  });

  it("posts both thresholds in order across one long turn", async (t) => {
    const now = clock(t);
    const calls: string[] = [];
    const eventChannel = progressChannel(calls);
    await handlerFor("turn.started")(
      turnStartedEvent,
      eventChannel,
      trustedCtx
    );
    now.advance(5 * MINUTE_MS - 1000);
    await handlerFor("reasoning.appended")(
      reasoningEvent("Checking the code."),
      eventChannel,
      trustedCtx
    );
    // The 5-minute line lands during streaming, before any action result.
    now.advance(2000);
    await handlerFor("reasoning.appended")(
      reasoningEvent("Checking the code more deeply."),
      eventChannel,
      trustedCtx
    );
    now.advance(3 * MINUTE_MS);
    await handlerFor("actions.requested")(
      actionsRequestedEvent,
      eventChannel,
      trustedCtx
    );
    now.advance(6 * MINUTE_MS);
    await handlerFor("action.result")(
      toolResultEvent,
      eventChannel,
      trustedCtx
    );
    now.advance(MINUTE_MS + 2000);
    await handlerFor("reasoning.appended")(
      reasoningEvent("Drafting the reply."),
      eventChannel,
      trustedCtx
    );
    // A further checkpoint after both lines never produces a third.
    now.advance(5 * MINUTE_MS);
    await handlerFor("action.result")(
      toolResultEvent,
      eventChannel,
      trustedCtx
    );
    await handlerFor("message.completed")(
      finalMessageEvent("All done."),
      eventChannel,
      trustedCtx
    );
    assert.deepEqual(postsOf(calls), [
      "post:Still working: 5 minutes in, 0 tool calls so far.",
      "post:Still working: 15 minutes in, 1 tool calls so far. Currently waiting on grep.",
      "post:All done.",
    ]);
    assert.equal(eventChannel.state.progress, undefined);
  });

  it("catches up one line per checkpoint when the first event arrives late", async (t) => {
    const now = clock(t);
    const calls: string[] = [];
    const eventChannel = progressChannel(calls);
    await handlerFor("turn.started")(
      turnStartedEvent,
      eventChannel,
      trustedCtx
    );
    // No lifecycle event until past both thresholds: the first checkpoint
    // posts the overdue 5-minute line, the next one the 15-minute line.
    now.advance(16 * MINUTE_MS);
    await handlerFor("reasoning.appended")(
      reasoningEvent("Back from a long tool call."),
      eventChannel,
      trustedCtx
    );
    now.advance(MINUTE_MS);
    await handlerFor("action.result")(
      toolResultEvent,
      eventChannel,
      trustedCtx
    );
    now.advance(MINUTE_MS);
    await handlerFor("action.result")(
      toolResultEvent,
      eventChannel,
      trustedCtx
    );
    assert.deepEqual(postsOf(calls), [
      "post:Still working: 5 minutes in, 0 tool calls so far.",
      "post:Still working: 15 minutes in, 1 tool calls so far. Currently waiting on grep.",
    ]);
    assert.equal(eventChannel.state.progress?.posts, 2);
  });

  it("retries an ambiguous progress post with the same provider id", async (t) => {
    const now = clock(t);
    const calls: string[] = [];
    const errors: unknown[] = [];
    t.mock.method(console, "error", (...args: unknown[]) => {
      errors.push(args);
    });
    let rejectNextPost = true;
    const postedIds = new Set<string>();
    const attemptedIds: string[] = [];
    const eventChannel = {
      slack: {
        channelId: "C0DEV",
        request: (_operation: string, body: Record<string, unknown>) => {
          const clientMessageId = String(body.client_msg_id);
          attemptedIds.push(clientMessageId);
          if (!postedIds.has(clientMessageId)) {
            postedIds.add(clientMessageId);
            calls.push(`post:${String(body.text)}`);
          }
          if (rejectNextPost) {
            rejectNextPost = false;
            return Promise.reject(new Error("response lost after acceptance"));
          }
          return Promise.resolve({ ok: true });
        },
        teamId: "T123",
        threadTs: "1700000000.000100",
      },
      state: {} as Record<string, unknown>,
      thread: {
        startTyping: (status?: string) => {
          calls.push(`typing:${status ?? ""}`);
          return Promise.resolve();
        },
      },
    } as unknown as SlackEventContext;
    await handlerFor("turn.started")(
      turnStartedEvent,
      eventChannel,
      trustedCtx
    );
    now.advance(5 * MINUTE_MS + 1000);
    // Slack accepts the first attempt but its response is lost. The error is
    // logged and the threshold stays unconsumed.
    await handlerFor("reasoning.appended")(
      reasoningEvent("Checking the code."),
      eventChannel,
      trustedCtx
    );
    assert.equal(errors.length, 1);
    assert.equal(eventChannel.state.progress?.posts, 0);
    // The next checkpoint retries the same logical post with the same
    // client_msg_id. Slack deduplicates it and the threshold is consumed.
    now.advance(MINUTE_MS);
    await handlerFor("action.result")(
      toolResultEvent,
      eventChannel,
      trustedCtx
    );
    assert.equal(eventChannel.state.progress?.posts, 1);
    assert.equal(attemptedIds.length, 2);
    assert.equal(attemptedIds[0], attemptedIds[1]);
    assert.match(attemptedIds[0] ?? "", UUID_V5);
    assert.deepEqual(postsOf(calls), [
      "post:Still working: 5 minutes in, 0 tool calls so far.",
    ]);
  });

  it("counts only tool results while every result refreshes the wait label", async (t) => {
    const now = clock(t);
    const calls: string[] = [];
    const eventChannel = progressChannel(calls);
    await handlerFor("turn.started")(
      turnStartedEvent,
      eventChannel,
      trustedCtx
    );
    now.advance(5 * MINUTE_MS + 1000);
    // A finished subagent updates the label but is not a tool call, so the
    // 5-minute line still reports zero tool calls.
    await handlerFor("action.result")(
      subagentResultEvent,
      eventChannel,
      trustedCtx
    );
    assert.deepEqual(postsOf(calls), [
      "post:Still working: 5 minutes in, 0 tool calls so far. Currently waiting on investigator.",
    ]);
    assert.equal(eventChannel.state.progress?.toolCalls, 0);
    assert.equal(eventChannel.state.progress?.waitLabel, "investigator");
    // A skill load also refreshes the label without increasing the count.
    await handlerFor("action.result")(
      skillResultEvent,
      eventChannel,
      trustedCtx
    );
    assert.equal(eventChannel.state.progress?.toolCalls, 0);
    assert.equal(eventChannel.state.progress?.waitLabel, "triage-investigate");
    // A tool result is the only kind that increments the promised count.
    await handlerFor("action.result")(
      toolResultEvent,
      eventChannel,
      trustedCtx
    );
    assert.equal(eventChannel.state.progress?.toolCalls, 1);
    assert.equal(eventChannel.state.progress?.waitLabel, "grep");
    assert.equal(postsOf(calls).length, 1);
  });

  it("clears a stale wait label for a bare skill request and unnamed result", async () => {
    const calls: string[] = [];
    const eventChannel = progressChannel(calls);
    await handlerFor("turn.started")(
      turnStartedEvent,
      eventChannel,
      trustedCtx
    );
    await handlerFor("actions.requested")(
      actionsRequestedEvent,
      eventChannel,
      trustedCtx
    );
    assert.equal(eventChannel.state.progress?.waitLabel, "grep");

    await handlerFor("actions.requested")(
      {
        ...actionsRequestedEvent,
        actions: [
          {
            callId: "c2",
            input: { skill: "triage-investigate" },
            kind: "load-skill",
          },
        ],
      },
      eventChannel,
      trustedCtx
    );
    assert.equal(eventChannel.state.progress?.waitLabel, null);

    await handlerFor("action.result")(
      toolResultEvent,
      eventChannel,
      trustedCtx
    );
    assert.equal(eventChannel.state.progress?.waitLabel, "grep");

    await handlerFor("action.result")(
      {
        ...skillResultEvent,
        result: {
          callId: "c4",
          kind: "load-skill-result",
          output: {},
        },
      },
      eventChannel,
      trustedCtx
    );
    assert.equal(eventChannel.state.progress?.waitLabel, null);
  });

  it("stays silent for an intake-only session across the whole turn", async (t) => {
    const now = clock(t);
    const calls: string[] = [];
    const eventChannel = progressChannel(calls);
    const intakeCtx = sessionWith({
      attributes: { intakeOnly: "true", trusted: "true" },
    });
    await handlerFor("turn.started")(turnStartedEvent, eventChannel, intakeCtx);
    assert.equal(eventChannel.state.progress, undefined);
    now.advance(6 * MINUTE_MS);
    await handlerFor("reasoning.appended")(
      reasoningEvent("Investigating."),
      eventChannel,
      intakeCtx
    );
    now.advance(4 * MINUTE_MS);
    await handlerFor("actions.requested")(
      actionsRequestedEvent,
      eventChannel,
      intakeCtx
    );
    now.advance(6 * MINUTE_MS);
    await handlerFor("action.result")(toolResultEvent, eventChannel, intakeCtx);
    await handlerFor("message.completed")(
      finalMessageEvent("Filed to Linear."),
      eventChannel,
      intakeCtx
    );
    // The final reply still lands; no progress line ever does.
    assert.deepEqual(postsOf(calls), ["post:Filed to Linear."]);
    assert.equal(eventChannel.state.progress, undefined);
  });

  it("tears down progress and posts the mirrored error on turn failure", async (t) => {
    const now = clock(t);
    const calls: string[] = [];
    const eventChannel = progressChannel(calls);
    await handlerFor("turn.started")(
      turnStartedEvent,
      eventChannel,
      trustedCtx
    );
    now.advance(2 * MINUTE_MS);
    await handlerFor("action.result")(
      toolResultEvent,
      eventChannel,
      trustedCtx
    );
    await handlerFor("turn.failed")(
      {
        code: "model-error",
        details: { errorId: "err_123", name: "AIError" },
        message: "Model call failed",
        sequence: 7,
        turnId: "t1",
      },
      eventChannel,
      trustedCtx
    );
    assert.deepEqual(postsOf(calls), [
      "post:I hit an error while handling your request (AIError: Model call failed).\n\nPlease try again, rephrase, or reach out if it keeps failing.\n\n_Error id: `err_123`_",
    ]);
    assert.equal(eventChannel.state.progress, undefined);
    // A late result after the failure cannot resurrect tracking or post.
    now.advance(20 * MINUTE_MS);
    await handlerFor("action.result")(
      toolResultEvent,
      eventChannel,
      trustedCtx
    );
    assert.equal(postsOf(calls).length, 1);
    assert.equal(eventChannel.state.progress, undefined);
  });

  it("ignores a late action result after the final reply", async (t) => {
    const now = clock(t);
    const calls: string[] = [];
    const eventChannel = progressChannel(calls);
    await handlerFor("turn.started")(
      turnStartedEvent,
      eventChannel,
      trustedCtx
    );
    now.advance(30 * 1000);
    await handlerFor("message.completed")(
      finalMessageEvent("All done."),
      eventChannel,
      trustedCtx
    );
    await handlerFor("action.result")(
      toolResultEvent,
      eventChannel,
      trustedCtx
    );
    assert.deepEqual(postsOf(calls), ["post:All done."]);
    assert.equal(eventChannel.state.progress, undefined);
  });

  it("clears progress state when the turn is cancelled", async () => {
    const handler = handlerFor("turn.cancelled");
    const calls: string[] = [];
    const eventChannel = progressChannel(calls, {
      progress: {
        posts: 1,
        startedAtMs: Date.now(),
        toolCalls: 3,
        waitLabel: null,
      },
    });
    await handler({ sequence: 1, turnId: "t1" }, eventChannel, {} as never);
    assert.deepEqual(calls, []);
    assert.equal(eventChannel.state.progress, undefined);
  });

  it("mirrors the default actions.requested typing label and prefers narration", async (t) => {
    const now = clock(t);
    const calls: string[] = [];
    const eventChannel = progressChannel(calls);
    await handlerFor("turn.started")(
      turnStartedEvent,
      eventChannel,
      trustedCtx
    );
    await handlerFor("actions.requested")(
      actionsRequestedEvent,
      eventChannel,
      trustedCtx
    );
    assert.deepEqual(typingsOf(calls), [
      "typing:Working...",
      "typing:grep useEveAgent",
    ]);
    // Buffered model narration wins over the derived label and is consumed.
    eventChannel.state.pendingToolCallMessage = "Checking Stripe now.";
    now.advance(1000);
    await handlerFor("actions.requested")(
      actionsRequestedEvent,
      eventChannel,
      trustedCtx
    );
    assert.deepEqual(typingsOf(calls), [
      "typing:Working...",
      "typing:grep useEveAgent",
      "typing:Checking Stripe now.",
    ]);
    assert.equal(eventChannel.state.pendingToolCallMessage, null);
  });

  it("mirrors the default reasoning.appended typing throttle", async (t) => {
    const now = clock(t);
    const calls: string[] = [];
    const eventChannel = progressChannel(calls);
    await handlerFor("turn.started")(
      turnStartedEvent,
      eventChannel,
      trustedCtx
    );
    await handlerFor("reasoning.appended")(
      reasoningEvent("First thought."),
      eventChannel,
      trustedCtx
    );
    // A different status inside the five-second window is suppressed.
    now.advance(1000);
    await handlerFor("reasoning.appended")(
      reasoningEvent("Different thought."),
      eventChannel,
      trustedCtx
    );
    // A substantial extension of the last posted status posts immediately.
    now.advance(1000);
    await handlerFor("reasoning.appended")(
      reasoningEvent("First thought. Extended."),
      eventChannel,
      trustedCtx
    );
    assert.deepEqual(typingsOf(calls), [
      "typing:Working...",
      "typing:First thought.",
      "typing:First thought. Extended.",
    ]);
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
