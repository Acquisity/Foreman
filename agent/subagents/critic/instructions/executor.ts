import { defineDynamic, defineInstructions } from "eve/instructions";
import { EXECUTOR_DISCOVERY } from "../../../lib/executor/instructions.js";
import { isSupportAuth } from "../../../lib/support/auth.js";
import { SUPPORT_DISCOVERY } from "../../../lib/support/instructions.js";
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        content: isSupportAuth(ctx.session.auth.initiator)
          ? SUPPORT_DISCOVERY
          : EXECUTOR_DISCOVERY,
      }),
  },
});
