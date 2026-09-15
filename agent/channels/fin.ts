import { defineChannel, POST } from "eve/channels";
import { receiveFinContext } from "../lib/fin-context-route.js";
import { receiveFinInvestigation } from "../lib/fin-investigation.js";
import {
  finInvestigationFailure,
  reduceFinEvent,
} from "../lib/fin-investigation-callback.js";
import type { FinInvestigationSlackReceipt } from "../lib/fin-investigation-slack.js";
import { finishFinRun } from "../lib/fin-run-completion.js";

export default defineChannel({
  context: (state) => ({ state }),
  events: {
    "message.completed"(event, channel) {
      channel.state.answer = reduceFinEvent(channel.state.answer, {
        finishReason: event.finishReason,
        message: event.message,
        type: "message.completed",
      }).answer;
    },
    async "session.completed"(_event, channel, ctx) {
      const { outcome } = reduceFinEvent(channel.state.answer, {
        type: "session.completed",
      });
      await finishFinRun(
        channel.state.runId,
        ctx.session.id,
        channel.state.slack,
        outcome ?? finInvestigationFailure
      );
    },
    async "session.failed"(event, channel) {
      await finishFinRun(
        channel.state.runId,
        event.sessionId,
        channel.state.slack,
        finInvestigationFailure
      );
    },
    "turn.started"(_event, channel) {
      channel.state.answer = reduceFinEvent(channel.state.answer, {
        type: "turn.started",
      }).answer;
    },
  },
  routes: [
    POST("/internal/fin/context", (request) => receiveFinContext(request)),
    POST("/internal/fin/investigation", receiveFinInvestigation),
  ],
  state: {
    answer: "",
    runId: null as string | null,
    slack: null as FinInvestigationSlackReceipt | null,
  },
});
