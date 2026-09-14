import { defineChannel, POST } from "eve/channels";
import { receiveFinProbe } from "../lib/fin-preview.js";
import {
  boundedFinAnswer,
  deliverFinCallback,
  type FinCallbackState,
  finDiagnosticFailure,
} from "../lib/fin-preview-callback.js";

import {
  type FinSlackReceipt,
  updateFinSlackReceipt,
} from "../lib/fin-preview-slack.js";

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
      await Promise.all([
        deliverFinCallback(channel.state.callback, ctx.session.id, "completed"),
        updateFinSlackReceipt(
          channel.state.slack,
          channel.state.answer
            ? { message: channel.state.answer, status: "completed" }
            : finDiagnosticFailure
        ),
      ]);
    },
    async "session.failed"(event, channel) {
      await Promise.all([
        deliverFinCallback(channel.state.callback, event.sessionId, "failed"),
        updateFinSlackReceipt(channel.state.slack, finDiagnosticFailure),
      ]);
    },
    "turn.started"(_event, channel) {
      channel.state.answer = "";
      if (channel.state.callback) {
        channel.state.callback.answer = "";
      }
    },
  },
  routes: [POST("/internal/fin-preview", receiveFinProbe)],
  state: {
    answer: "",
    callback: null as FinCallbackState | null,
    slack: null as FinSlackReceipt | null,
  },
});
