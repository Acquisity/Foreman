import { defineChannel, POST } from "eve/channels";
import { receiveFinProbe } from "../lib/fin-preview.js";
import {
  boundedFinAnswer,
  deliverFinCallback,
  type FinCallbackState,
} from "../lib/fin-preview-callback.js";

export default defineChannel({
  context: (state) => ({ state }),
  events: {
    "message.completed"(event, channel) {
      if (channel.state.callback && event.finishReason !== "tool-calls") {
        channel.state.callback.answer = boundedFinAnswer(event.message);
      }
    },
    async "session.completed"(_event, channel, ctx) {
      await deliverFinCallback(
        channel.state.callback,
        ctx.session.id,
        "completed"
      );
    },
    async "session.failed"(event, channel) {
      await deliverFinCallback(
        channel.state.callback,
        event.sessionId,
        "failed"
      );
    },
    "turn.started"(_event, channel) {
      if (channel.state.callback) {
        channel.state.callback.answer = "";
      }
    },
  },
  routes: [POST("/internal/fin-preview", receiveFinProbe)],
  state: { callback: null as FinCallbackState | null },
});
