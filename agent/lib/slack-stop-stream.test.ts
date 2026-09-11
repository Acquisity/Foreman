import assert from "node:assert/strict";
import { test } from "node:test";
import type { SlackInboundMessageContext } from "eve/channels/slack";
import type { MessageStreamEvent } from "eve/client";
import { cancelActiveSlackTurn } from "./slack-stop.js";

const event = (type: string, turnId?: string) =>
  ({ data: turnId ? { turnId } : {}, type }) as MessageStreamEvent;

function fixture(
  tail: number,
  at: (index: number) => MessageStreamEvent,
  confirmation: MessageStreamEvent[] = [
    event("turn.cancelled", "long-turn"),
    event("session.waiting"),
  ]
) {
  const starts: number[] = [];
  const cancellations: unknown[] = [];
  let delivered = 0;
  const session = {
    cancel: (options: unknown) => {
      cancellations.push(options);
      return Promise.resolve({ status: "accepted" });
    },
    getEventStream: ({ startIndex }: { startIndex: number }) => {
      starts.push(startIndex);
      let index = startIndex;
      return Promise.resolve(
        new ReadableStream<MessageStreamEvent>(
          {
            pull(controller) {
              const value =
                index <= tail ? at(index) : confirmation[index - tail - 1];
              if (!value) {
                controller.close();
                return;
              }
              delivered += 1;
              index += 1;
              controller.enqueue(value);
            },
          },
          { highWaterMark: 0 }
        )
      );
    },
    getStreamTailIndex: () => Promise.resolve(tail),
  };
  const ctx = {
    resolveSession: () => Promise.resolve(session),
  } as unknown as SlackInboundMessageContext;
  return { cancellations, ctx, delivered: () => delivered, starts };
}

test("a long running root turn is canceled without replaying its history", async () => {
  const f = fixture(100_000, (index) => {
    assert.ok(
      index === 100_000,
      "old history must not be read before cancellation"
    );
    return event("reasoning.appended", "long-turn");
  });
  assert.equal(await cancelActiveSlackTurn(f.ctx), "long-turn");
  assert.deepEqual(f.starts, [100_000, 100_001]);
  assert.deepEqual(f.cancellations, [{ turnId: "long-turn" }]);
  assert.equal(f.delivered(), 2);
});

test("a completed long turn is quiet and does not request cancellation", async () => {
  const f = fixture(100_000, (index) =>
    index === 100_000
      ? event("session.waiting")
      : event("reasoning.appended", "long-turn")
  );
  assert.equal(await cancelActiveSlackTurn(f.ctx), null);
  assert.deepEqual(f.cancellations, []);
  assert.equal(f.delivered(), 1);
});

test("a terminal turn event wins even before session.waiting is emitted", async () => {
  const f = fixture(3, (index) =>
    index === 3
      ? event("turn.completed", "long-turn")
      : event("reasoning.appended", "long-turn")
  );
  assert.equal(await cancelActiveSlackTurn(f.ctx), null);
  assert.deepEqual(f.cancellations, []);
});

test("forwarded child events are searched past without using the child turn id", async () => {
  const f = fixture(130, (index) =>
    index === 60
      ? event("subagent.called", "long-turn")
      : ({
          data: {
            callId: "child-call",
            event: event("reasoning.appended", "child-turn"),
            subagentName: "vision",
          },
          meta: { at: "2026-09-11T14:00:00Z", id: "evt_fixture" },
          type: "subagent.event",
        } as MessageStreamEvent)
  );
  assert.equal(await cancelActiveSlackTurn(f.ctx), "long-turn");
  assert.deepEqual(f.starts, [130, 66, 0, 131]);
  assert.deepEqual(f.cancellations, [{ turnId: "long-turn" }]);
});

test("a natural completion that wins the race is not reported as a successful stop", async () => {
  const f = fixture(4, () => event("reasoning.appended", "long-turn"), [
    event("turn.completed", "long-turn"),
    event("session.waiting"),
  ]);
  assert.equal(await cancelActiveSlackTurn(f.ctx), null);
  assert.deepEqual(f.cancellations, [{ turnId: "long-turn" }]);
});

test("a different turn cancellation cannot confirm a stale stop", async () => {
  const f = fixture(4, () => event("reasoning.appended", "long-turn"), [
    event("turn.cancelled", "new-turn"),
    event("session.waiting"),
  ]);
  assert.equal(await cancelActiveSlackTurn(f.ctx), null);
  assert.deepEqual(f.cancellations, [{ turnId: "long-turn" }]);
});

test("a long child-only tail does not issue one remote read per small window", async () => {
  const f = fixture(100_000, (index) =>
    index === 0 ? event("turn.started", "long-turn") : event("subagent.started")
  );
  assert.equal(await cancelActiveSlackTurn(f.ctx), "long-turn");
  assert.ok(
    f.starts.length < 20,
    "backward windows must grow for long child streams"
  );
  assert.deepEqual(f.cancellations, [{ turnId: "long-turn" }]);
});
