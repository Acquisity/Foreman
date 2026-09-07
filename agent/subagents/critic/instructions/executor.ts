import { defineDynamic, defineInstructions } from "eve/instructions";
import { executorSessionInstructions } from "../../../lib/executor/instructions.js";
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        content: executorSessionInstructions(ctx.session.auth.current),
      }),
  },
});
