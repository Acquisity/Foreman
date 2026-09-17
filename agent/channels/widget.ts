import { defineChannel, POST } from "eve/channels";
import {
  failWidgetRun,
  receiveWidgetMessage,
} from "../lib/widget-investigation.js";

export default defineChannel({
  context: (state) => ({ state }),
  events: {
    async "session.failed"(event, channel) {
      await failWidgetRun(channel.state.runId, event.sessionId);
    },
  },
  routes: [POST("/internal/widget/message", receiveWidgetMessage)],
  state: { runId: null as string | null },
});
