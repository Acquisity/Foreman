import { defineChannel, POST } from "eve/channels";
import { receiveFinContext } from "../lib/fin-context-route.js";
import { receiveFinInvestigation } from "../lib/fin-investigation.js";
import {
  boundedFinAnswer,
  deliverFinCallback,
  type FinInvestigationCallbackState,
  finInvestigationFailure,
} from "../lib/fin-investigation-callback.js";
import {
  type FinInvestigationSlackReceipt,
  updateFinInvestigationReceipt,
} from "../lib/fin-investigation-slack.js";

export default defineChannel({
  context: (state) => ({ state }),
  events: {
    "message.completed"(event, channel) {
      if (event.finishReason !== "tool-calls") {
        channel.state.answer = boundedFinAnswer(event.message);
        if (channel.state.callback) {
          channel.state.callback.answer = channel.state.answer;
        }
      }
    },
    async "session.completed"(_event, channel, ctx) {
      const outcome = channel.state.answer
        ? { message: channel.state.answer, status: "completed" as const }
        : finInvestigationFailure;
      await Promise.all([
        deliverFinCallback(channel.state.callback, ctx.session.id, "completed"),
        updateFinInvestigationReceipt(channel.state.slack, outcome),
      ]);
    },
    async "session.failed"(event, channel) {
      await Promise.all([
        deliverFinCallback(channel.state.callback, event.sessionId, "failed"),
        updateFinInvestigationReceipt(
          channel.state.slack,
          finInvestigationFailure
        ),
      ]);
    },
    "turn.started"(_event, channel) {
      channel.state.answer = "";
      if (channel.state.callback) {
        channel.state.callback.answer = "";
      }
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
