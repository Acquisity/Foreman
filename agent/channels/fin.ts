import { defineChannel, POST } from "eve/channels";
import { receiveFinContext } from "../lib/fin-context-route.js";
import { receiveFinInvestigation } from "../lib/fin-investigation.js";
import {
  deliverFinCallback,
  type FinInvestigationCallbackState,
  finInvestigationFailure,
  reduceFinEvent,
} from "../lib/fin-investigation-callback.js";
import {
  type FinInvestigationSlackReceipt,
  updateFinInvestigationReceipt,
} from "../lib/fin-investigation-slack.js";

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
      await Promise.all([
        deliverFinCallback(
          channel.state.callback,
          ctx.session.id,
          outcome ?? finInvestigationFailure
        ),
        updateFinInvestigationReceipt(channel.state.slack, outcome),
      ]);
    },
    async "session.failed"(event, channel) {
      await Promise.all([
        deliverFinCallback(
          channel.state.callback,
          event.sessionId,
          finInvestigationFailure
        ),
        updateFinInvestigationReceipt(
          channel.state.slack,
          finInvestigationFailure
        ),
      ]);
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
    callback: null as FinInvestigationCallbackState | null,
    slack: null as FinInvestigationSlackReceipt | null,
  },
});
