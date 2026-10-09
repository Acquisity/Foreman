import { defineChannel, GET, POST } from "eve/channels";
import {
  failWidgetRun,
  receiveWidgetMessage,
} from "../lib/widget-investigation.js";
import { LIVE_PROTOCOL } from "../lib/widget-live-policy.js";
import { isLiveActive } from "../lib/widget-replay.js";
import { receiveWidgetScreenshot } from "../lib/widget-screenshot.js";
import { serviceSecretRefusal } from "../lib/widget-service-secret.js";

export default defineChannel({
  context: (state) => ({ state }),
  events: {
    async "session.failed"(event, channel) {
      await failWidgetRun(channel.state.runId, event.sessionId);
    },
  },
  routes: [
    GET("/internal/widget/live", (request) => {
      if (!isLiveActive()) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return Promise.resolve(
        serviceSecretRefusal(request) ??
          new Response(LIVE_PROTOCOL, {
            headers: { "cache-control": "no-store" },
          })
      );
    }),
    POST("/internal/widget/message", receiveWidgetMessage),
    POST("/internal/widget/image", (request) =>
      receiveWidgetScreenshot(request)
    ),
  ],
  state: { runId: null as string | null },
});
