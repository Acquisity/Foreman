import { defineDynamic, defineInstructions } from "eve/instructions";
import { sessionLane } from "../../../lib/session-lane.js";
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        content: sessionLane(ctx.session.auth.initiator).discovery,
      }),
  },
});
