/**
 * Countable lifecycle logging. Every handler routes through the
 * never-throwing `logOpsEvent`, because eve surfaces a thrown hook as
 * `turn.failed` and escalates a failure-cascade hook throw to
 * `session.failed`. Failure events log the bounded code and message; payloads
 * such as message text, authorization challenge URLs, and input request
 * bodies never enter the log.
 *
 * `action.result` adds one line per tool call so a scan of `vercel logs` can
 * tabulate reach and failure per tool and per connection: successes are
 * otherwise invisible, and "never called" reads the same as "worked". The
 * line carries the tool name, the connection or none, `ok` or `error`, and
 * the failure class, never the tool input or output.
 */
import { defineHook } from "eve/hooks";
import { logOpsEvent } from "../lib/ops-log.js";

/**
 * Names the connection behind a tool call from the `<connection>__<tool>`
 * shape eve gives every connection and mounted extension tool; an authored
 * root tool has no separator and reports no connection. `toolResultFrom`
 * narrows one imported definition at a time, so using it here would mean
 * listing every connection just to read a prefix back.
 */
const connectionOf = (toolName: string): string | null => {
  const separator = toolName.indexOf("__");
  return separator > 0 ? toolName.slice(0, separator) : null;
};

export default defineHook({
  events: {
    "action.result": (event, ctx) => {
      const { result } = event.data;
      // Subagent and skill results are their own action kinds, not tool
      // calls, and carry no tool name.
      if (result.kind !== "tool-result") {
        return;
      }
      logOpsEvent("action.result", {
        // Only the bounded failure class, never the error message body.
        code: event.data.error?.code,
        connection: connectionOf(result.toolName),
        // No duration: neither actions.requested nor action.result carries a
        // timestamp or elapsed time, and a hook must not keep its own state.
        outcome:
          result.isError || event.data.status !== "completed" ? "error" : "ok",
        sessionId: ctx.session.id,
        tool: result.toolName,
        turnId: event.data.turnId,
      });
    },
    "authorization.required": (event, ctx) => {
      logOpsEvent("authorization.required", {
        connection: event.data.name,
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
      });
    },
    "input.requested": (event, ctx) => {
      logOpsEvent("input.requested", {
        requests: event.data.requests.length,
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
      });
    },
    "session.completed": (_event, ctx) => {
      logOpsEvent("session.completed", { sessionId: ctx.session.id });
    },
    "session.failed": (event, ctx) => {
      logOpsEvent("session.failed", {
        code: event.data.code,
        message: event.data.message,
        sessionId: ctx.session.id,
      });
    },
    "session.started": (_event, ctx) => {
      logOpsEvent("session.started", { sessionId: ctx.session.id });
    },
    "step.failed": (event, ctx) => {
      logOpsEvent("step.failed", {
        code: event.data.code,
        message: event.data.message,
        sessionId: ctx.session.id,
        stepIndex: event.data.stepIndex,
        turnId: event.data.turnId,
      });
    },
    "turn.cancelled": (event, ctx) => {
      logOpsEvent("turn.cancelled", {
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
      });
    },
    "turn.completed": (event, ctx) => {
      logOpsEvent("turn.completed", {
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
      });
    },
    "turn.failed": (event, ctx) => {
      logOpsEvent("turn.failed", {
        code: event.data.code,
        message: event.data.message,
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
      });
    },
    "turn.started": (event, ctx) => {
      logOpsEvent("turn.started", {
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
      });
    },
  },
});
