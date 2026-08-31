import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SlackChannelState } from "eve/channels/slack";
import {
  decideSlackProgressLine,
  SLACK_PROGRESS_LABEL_LIMIT,
  SLACK_PROGRESS_THRESHOLDS_MS,
  type SlackProgressState,
} from "./slack-progress.js";

const [FIVE_MINUTES, FIFTEEN_MINUTES] = SLACK_PROGRESS_THRESHOLDS_MS;

const stateAt = (
  startedAtMs: number,
  overrides: Partial<SlackProgressState> = {}
): SlackProgressState => ({
  posts: 0,
  startedAtMs,
  toolCalls: 0,
  waitLabel: null,
  ...overrides,
});

describe("decideSlackProgressLine", () => {
  it("returns null for missing state", () => {
    assert.equal(decideSlackProgressLine(undefined, FIFTEEN_MINUTES), null);
    assert.equal(decideSlackProgressLine(null, FIFTEEN_MINUTES), null);
  });

  it("pins the two thresholds at 5 and 15 minutes", () => {
    assert.deepEqual(SLACK_PROGRESS_THRESHOLDS_MS, [300_000, 900_000]);
  });

  it("returns no line before the 5-minute threshold", () => {
    assert.equal(decideSlackProgressLine(stateAt(0), FIVE_MINUTES - 1), null);
  });

  it("returns the first line exactly at the 5-minute threshold", () => {
    const line = decideSlackProgressLine(
      stateAt(0, { toolCalls: 3 }),
      FIVE_MINUTES
    );
    assert.equal(line, "Still working: 5 minutes in, 3 tool calls so far.");
  });

  it("returns the first line after the threshold when none was posted yet", () => {
    const line = decideSlackProgressLine(stateAt(0), FIVE_MINUTES + 60_000);
    assert.equal(line, "Still working: 5 minutes in, 0 tool calls so far.");
  });

  it("counts elapsed time from the recorded start, not from zero", () => {
    const startedAtMs = 1_000_000;
    assert.equal(
      decideSlackProgressLine(
        stateAt(startedAtMs),
        startedAtMs + FIVE_MINUTES - 1
      ),
      null
    );
    assert.notEqual(
      decideSlackProgressLine(stateAt(startedAtMs), startedAtMs + FIVE_MINUTES),
      null
    );
  });

  it("returns no second line before 15 minutes once one was posted", () => {
    const state = stateAt(0, { posts: 1 });
    assert.equal(decideSlackProgressLine(state, FIVE_MINUTES), null);
    assert.equal(decideSlackProgressLine(state, FIFTEEN_MINUTES - 1), null);
  });

  it("returns the second line exactly at the 15-minute threshold", () => {
    const line = decideSlackProgressLine(
      stateAt(0, { posts: 1, toolCalls: 9 }),
      FIFTEEN_MINUTES
    );
    assert.equal(line, "Still working: 15 minutes in, 9 tool calls so far.");
  });

  it("never returns a third line", () => {
    const state = stateAt(0, { posts: 2 });
    assert.equal(decideSlackProgressLine(state, FIFTEEN_MINUTES), null);
    assert.equal(decideSlackProgressLine(state, FIFTEEN_MINUTES * 10), null);
  });

  it("includes the current wait label when one is set", () => {
    const line = decideSlackProgressLine(
      stateAt(0, { waitLabel: "reviewing the diff" }),
      FIVE_MINUTES
    );
    assert.equal(
      line,
      "Still working: 5 minutes in, 0 tool calls so far. Currently waiting on reviewing the diff."
    );
  });

  it("treats a blank wait label as no label", () => {
    const line = decideSlackProgressLine(
      stateAt(0, { waitLabel: "   " }),
      FIVE_MINUTES
    );
    assert.equal(line, "Still working: 5 minutes in, 0 tool calls so far.");
  });

  it("bounds the wait label so the line stays short", () => {
    const line = decideSlackProgressLine(
      stateAt(0, { waitLabel: "x".repeat(SLACK_PROGRESS_LABEL_LIMIT + 50) }),
      FIVE_MINUTES
    );
    assert.ok(line);
    assert.equal(
      line.includes(`${"x".repeat(SLACK_PROGRESS_LABEL_LIMIT)}...`),
      true
    );
    assert.equal(
      line.includes("x".repeat(SLACK_PROGRESS_LABEL_LIMIT + 1)),
      false
    );
  });

  it("flattens a multiline wait label into one line", () => {
    const line = decideSlackProgressLine(
      stateAt(0, {
        waitLabel: "reviewing the diff\nsecond line\r\nthird\tline",
      }),
      FIVE_MINUTES
    );
    assert.ok(line);
    assert.equal(line.includes("\n"), false);
    assert.equal(line.includes("\r"), false);
    assert.equal(
      line.endsWith(
        "Currently waiting on reviewing the diff second line third line."
      ),
      true
    );
  });

  it("replaces control characters in the wait label with spaces", () => {
    const line = decideSlackProgressLine(
      stateAt(0, { waitLabel: "waiting\u0000on\u000Btools" }),
      FIVE_MINUTES
    );
    assert.ok(line);
    assert.equal(line.endsWith("Currently waiting on waiting on tools."), true);
  });

  it("never splits a surrogate pair when truncating the wait label", () => {
    const label = `${"x".repeat(SLACK_PROGRESS_LABEL_LIMIT - 1)}😀`;
    const line = decideSlackProgressLine(
      stateAt(0, { waitLabel: label }),
      FIVE_MINUTES
    );
    assert.ok(line);
    assert.equal(
      line.endsWith(`${"x".repeat(SLACK_PROGRESS_LABEL_LIMIT - 1)}....`),
      true
    );
    assert.equal(line.includes("😀"), false);
    assert.equal(line.includes("�"), false);
  });

  it("keeps an emoji intact when the cut lands on a pair boundary", () => {
    const label = `${"x".repeat(SLACK_PROGRESS_LABEL_LIMIT - 2)}😀tail`;
    const line = decideSlackProgressLine(
      stateAt(0, { waitLabel: label }),
      FIVE_MINUTES
    );
    assert.ok(line);
    assert.equal(
      line.endsWith(`${"x".repeat(SLACK_PROGRESS_LABEL_LIMIT - 2)}😀....`),
      true
    );
  });
});

describe("SlackProgressState channel typing", () => {
  it("round-trips through the Slack channel state as JSON", () => {
    const channelState: SlackChannelState = {
      channelId: "C123",
      progress: stateAt(1000, { posts: 1, toolCalls: 2, waitLabel: "tools" }),
      teamId: "T123",
      threadTs: "123.456",
    };
    const hydrated = JSON.parse(
      JSON.stringify(channelState)
    ) as SlackChannelState;
    assert.deepEqual(hydrated.progress, {
      posts: 1,
      startedAtMs: 1000,
      toolCalls: 2,
      waitLabel: "tools",
    });
  });
});
