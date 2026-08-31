import { defineHook } from "eve/hooks";
import { logOpsEvent } from "../lib/ops-log.js";

/**
 * Countable lifecycle logging. Every handler routes through the
 * never-throwing `logOpsEvent`, because eve surfaces a thrown hook as
 * `turn.failed` and escalates a failure-cascade hook throw to
 * `session.failed`. Failure events log the bounded code and message; payloads
 * such as message text, authorization challenge URLs, and input request
 * bodies never enter the log.
 */
export default defineHook({
  events: {
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
