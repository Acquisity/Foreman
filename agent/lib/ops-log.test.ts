import assert from "node:assert/strict";
import { describe, it } from "node:test";
import opsHook from "../hooks/ops.js";
import {
  formatOpsEvent,
  logOpsEvent,
  OPS_LOG_LINE_LIMIT,
  OPS_LOG_STRING_LIMIT,
} from "./ops-log.js";

describe("formatOpsEvent", () => {
  it("emits one line of valid JSON with the event and fields", () => {
    const line = formatOpsEvent("turn.completed", {
      sessionId: "s1",
      turnId: "t1",
    });
    assert.equal(line.includes("\n"), false);
    assert.deepEqual(JSON.parse(line), {
      event: "turn.completed",
      sessionId: "s1",
      turnId: "t1",
    });
  });

  it("keeps the event name when a field is also named event", () => {
    const parsed = JSON.parse(
      formatOpsEvent("session.started", {
        event: "forged",
      } as Parameters<typeof formatOpsEvent>[1])
    );
    assert.equal(parsed.event, "session.started");
  });

  it("truncates messages and event names to the string bound", () => {
    const longEvent = "e".repeat(OPS_LOG_STRING_LIMIT + 50);
    const parsed = JSON.parse(
      formatOpsEvent(longEvent, {
        message: "x".repeat(10_000),
      })
    );
    assert.equal(parsed.message.length, OPS_LOG_STRING_LIMIT + 3);
    assert.equal(parsed.message.endsWith("..."), true);
    assert.equal(parsed.event.length, OPS_LOG_STRING_LIMIT + 3);
    assert.equal(parsed.event.endsWith("..."), true);
  });

  it("serializes non-string values without conversion hooks", () => {
    let toStringCalls = 0;
    const objectValue = {
      toString() {
        toStringCalls += 1;
        return "unsafe";
      },
    };
    const parsed = JSON.parse(
      formatOpsEvent("input.requested", {
        code: 10n,
        connection: Symbol("connection"),
        message: objectValue,
        requests: 3,
        sessionId: undefined,
        stepIndex: Number.NaN,
        turnId: () => "turn",
      })
    );
    assert.deepEqual(parsed, {
      code: "[BigInt]",
      connection: "[Symbol]",
      event: "input.requested",
      message: "[Object]",
      requests: 3,
      sessionId: null,
      stepIndex: "[NonFiniteNumber]",
      turnId: "[Function]",
    });
    assert.equal(toStringCalls, 0);
  });

  it("ignores unknown fields instead of traversing them", () => {
    let ownKeysCalls = 0;
    let descriptorCalls = 0;
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          descriptorCalls += 1;
          throw new Error("must not inspect unknown values");
        },
        ownKeys: () => {
          ownKeysCalls += 1;
          return Array.from({ length: 50_000 }, (_, index) => `key${index}`);
        },
      }
    );
    const parsed = JSON.parse(
      formatOpsEvent("turn.started", {
        hostile,
      } as Parameters<typeof formatOpsEvent>[1])
    );
    assert.deepEqual(parsed, { event: "turn.started" });
    assert.equal(ownKeysCalls, 0);
    assert.equal(descriptorCalls, 0);
  });

  it("performs a constant number of descriptor reads", () => {
    let descriptorReads = 0;
    let ownKeysCalls = 0;
    const fields = new Proxy(
      { sessionId: "s1", turnId: "t1" },
      {
        getOwnPropertyDescriptor(target, key) {
          descriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        ownKeys() {
          ownKeysCalls += 1;
          return Array.from({ length: 50_000 }, (_, index) => `key${index}`);
        },
      }
    );
    const parsed = JSON.parse(formatOpsEvent("turn.started", fields));
    assert.deepEqual(parsed, {
      event: "turn.started",
      sessionId: "s1",
      turnId: "t1",
    });
    assert.equal(descriptorReads, 9);
    assert.equal(ownKeysCalls, 0);
  });

  it("falls back when a known-field descriptor read throws", () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("hostile");
        },
      }
    );
    const line = formatOpsEvent("step.failed", hostile);
    assert.equal(line.length <= OPS_LOG_LINE_LIMIT, true);
    assert.deepEqual(JSON.parse(line), {
      error: "ops_log_format_failed",
      event: "step.failed",
    });
  });
});

describe("logOpsEvent", () => {
  it("emits exactly one formatted line through the logger", () => {
    const lines: string[] = [];
    logOpsEvent("session.failed", { code: "boom" }, (line) => {
      lines.push(line);
    });
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      code: "boom",
      event: "session.failed",
    });
  });

  it("never throws when the logger throws", () => {
    assert.doesNotThrow(() => {
      logOpsEvent("turn.cancelled", {}, () => {
        throw new Error("logger down");
      });
    });
  });
});

type ActionResultHandler = (
  event: {
    data: {
      error?: { code: string; message: string };
      result: {
        callId: string;
        isError?: boolean;
        kind: string;
        output: unknown;
        toolName: string;
      };
      status: string;
      turnId: string;
    };
  },
  ctx: { session: { id: string } }
) => void;

/** Runs the hook's action.result handler and returns the lines it logged. */
const runActionResult = (
  data: Parameters<ActionResultHandler>[0]["data"]
): string[] => {
  const handler = opsHook.events?.["action.result"] as ActionResultHandler;
  const lines: string[] = [];
  const { info } = console;
  console.info = (line: string) => {
    lines.push(line);
  };
  try {
    handler({ data }, { session: { id: "s1" } });
  } finally {
    console.info = info;
  }
  return lines;
};

describe("ops hook action.result", () => {
  it("logs one bounded payload-free line for an ok tool result", () => {
    const lines = runActionResult({
      result: {
        callId: "c1",
        kind: "tool-result",
        output: { secret: "customer@example.com" },
        toolName: "linear__get_issue",
      },
      status: "completed",
      turnId: "t1",
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].length <= OPS_LOG_LINE_LIMIT, true);
    assert.equal(lines[0].includes("\n"), false);
    assert.deepEqual(JSON.parse(lines[0]), {
      connection: "linear",
      event: "action.result",
      outcome: "ok",
      sessionId: "s1",
      tool: "linear__get_issue",
      turnId: "t1",
    });
  });

  it("logs no error code for an error tool result", () => {
    const lines = runActionResult({
      error: { code: "tool_execution_failed", message: "x".repeat(10_000) },
      result: {
        callId: "c2",
        isError: true,
        kind: "tool-result",
        output: "stack trace with customer@example.com",
        toolName: "read_file",
      },
      status: "failed",
      turnId: "t1",
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].length <= OPS_LOG_LINE_LIMIT, true);
    assert.deepEqual(JSON.parse(lines[0]), {
      connection: null,
      event: "action.result",
      outcome: "error",
      sessionId: "s1",
      tool: "read_file",
      turnId: "t1",
    });
  });

  it("never logs an error code eve read back out of the tool output", () => {
    // eve builds `event.data.error` with `readActionResultOutputError`, which
    // returns the tool output's own `code` and `message` verbatim. Logging
    // that code would put tool output in the log.
    const output = {
      code: "CUSTOMER-4242",
      message: "billing failed for customer@example.com",
    };
    const lines = runActionResult({
      error: output,
      result: {
        callId: "c4",
        isError: true,
        kind: "tool-result",
        output,
        toolName: "stripe__create_refund",
      },
      status: "failed",
      turnId: "t1",
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes("CUSTOMER-4242"), false);
    assert.equal(lines[0].includes("customer@example.com"), false);
    assert.deepEqual(JSON.parse(lines[0]), {
      connection: "stripe",
      event: "action.result",
      outcome: "error",
      sessionId: "s1",
      tool: "stripe__create_refund",
      turnId: "t1",
    });
  });

  it("reports an error outcome for a rejected tool result", () => {
    const lines = runActionResult({
      result: {
        callId: "c5",
        kind: "tool-result",
        output: "rejected",
        toolName: "github__createPullRequest",
      },
      status: "rejected",
      turnId: "t1",
    });
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      connection: "github",
      event: "action.result",
      outcome: "error",
      sessionId: "s1",
      tool: "github__createPullRequest",
      turnId: "t1",
    });
  });

  it("logs nothing for a subagent or skill result", () => {
    assert.deepEqual(
      runActionResult({
        result: {
          callId: "c3",
          kind: "subagent-result",
          output: "done",
          toolName: "vision",
        },
        status: "completed",
        turnId: "t1",
      }),
      []
    );
  });
});

describe("ops hook", () => {
  it("subscribes to exactly the eleven covered events", () => {
    assert.deepEqual(
      Object.keys(opsHook.events ?? {}).sort(),
      [
        "action.result",
        "authorization.required",
        "input.requested",
        "session.completed",
        "session.failed",
        "session.started",
        "step.failed",
        "turn.cancelled",
        "turn.completed",
        "turn.failed",
        "turn.started",
      ].sort()
    );
    for (const handler of Object.values(opsHook.events ?? {})) {
      assert.equal(typeof handler, "function");
    }
  });
});
