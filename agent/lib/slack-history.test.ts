import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  loadThreadContextMessages,
  type SlackInboundMessageContext,
  type SlackMessage,
  type SlackThreadMessage,
} from "eve/channels/slack";
import { slackFreshSessionHistory } from "./slack-history.js";

const entry = (ts: string, text: string, isMe = false): SlackThreadMessage => ({
  botId: isMe ? "B123" : undefined,
  isMe,
  markdown: text,
  raw: {},
  text,
  threadTs: "1.000",
  ts,
  user: isMe ? "U_BOT" : "U_PERSON",
});
const trigger = { threadTs: "1.000", ts: "5.000" } as SlackMessage;
const context = (
  messages: readonly SlackThreadMessage[],
  existingSession = false,
  refresh = () => Promise.resolve()
): SlackInboundMessageContext =>
  ({
    resolveSession: () =>
      Promise.resolve(existingSession ? { id: "existing" } : undefined),
    thread: { recentMessages: messages, refresh },
  }) as unknown as SlackInboundMessageContext;

const history = [
  entry("1.000", "Initial request"),
  entry("2.000", "Earlier answer", true),
  entry("3.000", "Later unmentioned message"),
  entry("5.000", "Triggering request"),
];

describe("fresh Slack session history", () => {
  it("restores the earlier conversation through the last agent reply exactly once", async () => {
    const ctx = context(history);
    const prefix = await slackFreshSessionHistory(ctx, trigger);
    assert.ok(prefix);
    const nativeSuffix = await loadThreadContextMessages(ctx.thread, trigger, {
      since: "last-agent-reply",
    });
    assert.ok(prefix.includes("Initial request"));
    assert.ok(prefix.includes("Earlier answer"));
    assert.ok(prefix.includes('"author":"U_PERSON"'));
    assert.ok(prefix.includes("untrusted historical context"));
    assert.ok(!prefix.includes("Later unmentioned message"));
    assert.ok(!prefix.includes("Triggering request"));
    assert.deepEqual(
      nativeSuffix.map((message) => message.text),
      ["Later unmentioned message"]
    );
  });

  it("does not restore history again for a later message in the live session", async () => {
    let refreshes = 0;
    assert.equal(
      await slackFreshSessionHistory(
        context(history, true, () => {
          refreshes += 1;
          return Promise.resolve();
        }),
        trigger
      ),
      undefined
    );
    assert.equal(refreshes, 0);
  });

  it("does not look up history or a session for a new thread root", async () => {
    const ctx = {
      resolveSession: () => {
        throw new Error("should not resolve");
      },
    } as unknown as SlackInboundMessageContext;
    assert.equal(
      await slackFreshSessionHistory(ctx, { ...trigger, ts: "1.000" }),
      undefined
    );
  });

  it("leaves all earlier messages to native lookback when there is no bot reply", async () => {
    const ctx = context([
      entry("1.000", "Initial request"),
      entry("3.000", "Later unmentioned message"),
    ]);
    assert.equal(await slackFreshSessionHistory(ctx, trigger), undefined);
    assert.equal(
      (
        await loadThreadContextMessages(ctx.thread, trigger, {
          since: "last-agent-reply",
        })
      ).length,
      2
    );
  });

  it("preserves the last bot boundary even when another bot replies later", async () => {
    const ctx = context([
      ...history.slice(0, 2),
      { ...entry("3.000", "Another bot"), botId: "OTHER" },
    ]);
    const prefix = await slackFreshSessionHistory(ctx, trigger);
    assert.ok(prefix?.includes("Earlier answer"));
    assert.ok(!prefix?.includes("Another bot"));
  });

  it("drops oldest whole messages and bounds the complete added context", async () => {
    const ctx = context([
      entry("1.000", `oldest-${"a".repeat(20_000)}`),
      entry("2.000", `middle-${"b".repeat(20_000)}`),
      entry("3.000", "Newest answer", true),
    ]);
    const prefix = await slackFreshSessionHistory(ctx, trigger);
    assert.ok(prefix && prefix.length <= 32_000);
    assert.ok(prefix.includes("Older whole messages were omitted"));
    assert.ok(!prefix.includes("oldest-"));
    assert.ok(prefix.includes(`middle-${"b".repeat(20_000)}`));
    assert.ok(prefix.includes("Newest answer"));
  });

  it("does not slice one oversize message into misleading partial history", async () => {
    const prefix = await slackFreshSessionHistory(
      context([entry("1.000", "x".repeat(40_000), true)]),
      trigger
    );
    assert.ok(prefix && prefix.length <= 32_000);
    assert.ok(prefix.includes("Older whole messages were omitted"));
    assert.ok(!prefix.includes("xxxxxxxx"));
  });

  it("marks the native first-50 limit even without a recovered bot reply", async () => {
    const entries = Array.from({ length: 50 }, (_, index) =>
      entry(`1.${index}`, "Earlier message")
    );
    const prefix = await slackFreshSessionHistory(context(entries), trigger);
    assert.ok(prefix?.includes("at most the first 50"));
    assert.ok(prefix?.includes("can be incomplete"));
    assert.ok(!prefix?.includes("Earlier message"));
  });

  it("reports unavailable history when native refresh swallows a failed fetch", async () => {
    const prefix = await slackFreshSessionHistory(context([]), trigger);
    assert.ok(prefix?.includes("history is unavailable"));
    assert.ok(prefix?.includes("available Slack reads"));
  });

  it("keeps the request usable when history refresh throws", async () => {
    const prefix = await slackFreshSessionHistory(
      context([], false, () =>
        Promise.reject(new Error("private provider details"))
      ),
      trigger
    );
    assert.ok(prefix?.includes("history is unavailable"));
    assert.ok(!prefix?.includes("private provider details"));
  });
});
