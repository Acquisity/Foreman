import { defineDynamic, defineInstructions } from "eve/instructions";
import { composePrompt } from "../lib/prompts.js";
import { sessionLane } from "../lib/session-lane.js";

// Resolve each turn so existing sessions receive the general prompt and the
// support instructions selected by their signed initiator after a deployment.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        content: composePrompt(sessionLane(ctx.session.auth.initiator)),
      }),
  },
});
