import { defineChannel, GET, POST } from "eve/channels";
import {
  replayResultResponse,
  startReplay,
} from "../lib/triage-replay/route.js";

export default defineChannel({
  routes: [
    POST("/internal/triage/replay", (request, args) =>
      startReplay(request, args)
    ),
    GET("/internal/triage/replay/result", (request) =>
      replayResultResponse(request)
    ),
  ],
});
