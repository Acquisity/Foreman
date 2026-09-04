import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SlackChannelState } from "eve/channels/slack";
import {
  decideSlackProgressLine,
  SLACK_PROGRESS_INTERVAL_MS,
  SLACK_PROGRESS_LABEL_LIMIT,
  type SlackProgressState,
  slackProgressActionLabel,
  slackProgressActionRequestLabel,
} from "./slack-progress.js";

const FIVE_MINUTES = SLACK_PROGRESS_INTERVAL_MS;
const FIFTEEN_MINUTES = 3 * SLACK_PROGRESS_INTERVAL_MS;

const lineAt = (
  state: SlackProgressState | null | undefined,
  nowMs: number
): string | null => decideSlackProgressLine(state, nowMs)?.line ?? null;

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
    assert.equal(lineAt(undefined, FIFTEEN_MINUTES), null);
    assert.equal(lineAt(null, FIFTEEN_MINUTES), null);
  });

  it("pins the cadence at 5 minutes", () => {
    assert.equal(SLACK_PROGRESS_INTERVAL_MS, 300_000);
  });

  it("returns no line before the 5-minute threshold", () => {
    assert.equal(lineAt(stateAt(0), FIVE_MINUTES - 1), null);
  });

  it("returns the first line exactly at the 5-minute threshold", () => {
    assert.deepEqual(
      decideSlackProgressLine(stateAt(0, { toolCalls: 3 }), FIVE_MINUTES),
      { line: "Still working: 5 minutes in, 3 tool calls so far.", posts: 1 }
    );
  });

  it("reports the actual elapsed minutes after the threshold", () => {
    assert.equal(
      lineAt(stateAt(0), FIVE_MINUTES + 60_000),
      "Still working: 6 minutes in, 0 tool calls so far."
    );
  });

  it("counts elapsed time from the recorded start, not from zero", () => {
    const startedAtMs = 1_000_000;
    assert.equal(
      lineAt(stateAt(startedAtMs), startedAtMs + FIVE_MINUTES - 1),
      null
    );
    assert.notEqual(
      lineAt(stateAt(startedAtMs), startedAtMs + FIVE_MINUTES),
      null
    );
  });

  it("waits a full interval after each posted line", () => {
    const state = stateAt(0, { posts: 1 });
    assert.equal(lineAt(state, FIVE_MINUTES), null);
    assert.equal(lineAt(state, 2 * FIVE_MINUTES - 1), null);
    assert.deepEqual(
      decideSlackProgressLine(
        stateAt(0, { posts: 1, toolCalls: 9 }),
        2 * FIVE_MINUTES
      ),
      { line: "Still working: 10 minutes in, 9 tool calls so far.", posts: 2 }
    );
  });

  it("keeps posting every 5 minutes for as long as the turn runs", () => {
    for (const posts of [2, 3, 11, 40]) {
      const nowMs = (posts + 1) * FIVE_MINUTES;
      assert.deepEqual(decideSlackProgressLine(stateAt(0, { posts }), nowMs), {
        line: `Still working: ${(posts + 1) * 5} minutes in, 0 tool calls so far.`,
        posts: posts + 1,
      });
      assert.equal(lineAt(stateAt(0, { posts }), nowMs - 1), null);
    }
  });

  it("skips the intervals a late checkpoint missed instead of catching up", () => {
    // A 33-minute parked delegation ends: one line, then the count jumps so
    // the next checkpoint a few seconds later posts nothing.
    const due = decideSlackProgressLine(stateAt(0, { posts: 1 }), 33 * 60_000);
    assert.deepEqual(due, {
      line: "Still working: 33 minutes in, 0 tool calls so far.",
      posts: 6,
    });
    assert.equal(lineAt(stateAt(0, { posts: 6 }), 33 * 60_000 + 5000), null);
    assert.notEqual(lineAt(stateAt(0, { posts: 6 }), 7 * FIVE_MINUTES), null);
  });

  it("includes the current wait label when one is set", () => {
    const line = lineAt(
      stateAt(0, { waitLabel: "reviewing the diff" }),
      FIVE_MINUTES
    );
    assert.equal(
      line,
      "Still working: 5 minutes in, 0 tool calls so far. Currently waiting on reviewing the diff."
    );
  });

  it("treats a blank wait label as no label", () => {
    const line = lineAt(stateAt(0, { waitLabel: "   " }), FIVE_MINUTES);
    assert.equal(line, "Still working: 5 minutes in, 0 tool calls so far.");
  });

  it("bounds the wait label so the line stays short", () => {
    const line = lineAt(
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
    const line = lineAt(
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
    const line = lineAt(
      stateAt(0, { waitLabel: "waiting\u0000on\u000Btools" }),
      FIVE_MINUTES
    );
    assert.ok(line);
    assert.equal(line.endsWith("Currently waiting on waiting on tools."), true);
  });

  it("never splits a surrogate pair when truncating the wait label", () => {
    const label = `${"x".repeat(SLACK_PROGRESS_LABEL_LIMIT - 1)}😀`;
    const line = lineAt(stateAt(0, { waitLabel: label }), FIVE_MINUTES);
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
    const line = lineAt(stateAt(0, { waitLabel: label }), FIVE_MINUTES);
    assert.ok(line);
    assert.equal(
      line.endsWith(`${"x".repeat(SLACK_PROGRESS_LABEL_LIMIT - 2)}😀....`),
      true
    );
  });
});

describe("slackProgressActionLabel", () => {
  it("names a finished tool call", () => {
    assert.equal(
      slackProgressActionLabel({ kind: "tool-result", toolName: "grep" }),
      "grep"
    );
  });

  it("names a finished subagent call", () => {
    assert.equal(
      slackProgressActionLabel({
        kind: "subagent-result",
        subagentName: "investigator",
      }),
      "investigator"
    );
  });

  it("names a skill load that activated a skill", () => {
    assert.equal(
      slackProgressActionLabel({
        kind: "load-skill-result",
        name: "triage-investigate",
      }),
      "triage-investigate"
    );
  });

  it("returns null when a skill load names nothing", () => {
    assert.equal(slackProgressActionLabel({ kind: "load-skill-result" }), null);
  });
});

describe("slackProgressActionRequestLabel", () => {
  it("names the first requested tool call", () => {
    assert.equal(
      slackProgressActionRequestLabel([
        { kind: "tool-call", toolName: "grep" },
        { kind: "tool-call", toolName: "read_file" },
      ]),
      "grep"
    );
  });

  it("names a requested subagent or remote agent", () => {
    assert.equal(
      slackProgressActionRequestLabel([
        { kind: "subagent-call", subagentName: "investigator" },
      ]),
      "investigator"
    );
    assert.equal(
      slackProgressActionRequestLabel([
        { kind: "remote-agent-call", remoteAgentName: "remote-critic" },
      ]),
      "remote-critic"
    );
  });

  it("returns null for an empty batch or a bare skill load", () => {
    assert.equal(slackProgressActionRequestLabel([]), null);
    assert.equal(
      slackProgressActionRequestLabel([{ kind: "load-skill" }]),
      null
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
