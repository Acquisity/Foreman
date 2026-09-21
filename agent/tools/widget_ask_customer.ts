import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  ASK_TOOL_QUESTION,
  nextActionEnabled,
} from "../lib/widget-next-action.js";
import { isWidgetSupport } from "../lib/widget-scope.js";

/**
 * Carries a clarify decision to the finish as data. The question arrives as a
 * validated tool input and is read back from the tool's own result, so nothing
 * depends on how the investigator formats its closing prose. It changes nothing
 * and reads nothing; the question still goes through the ownership scan and the
 * reviewer before the customer sees it. Exists only while the pilot flag is on.
 */
const tool = defineTool({
  approval: (ctx) =>
    isWidgetSupport(ctx.session.auth.initiator)
      ? "not-applicable"
      : { reason: "Support widget investigations only.", type: "denied" },
  description:
    "Record the one question to ask the customer when a single detail only they " +
    "can give is needed before anything more can be checked. One short, friendly " +
    "question that states no facts, makes no promises, names no tool or system and " +
    "asks for no file or screenshot.",
  execute({ question }, ctx) {
    if (!isWidgetSupport(ctx.session.auth.initiator)) {
      throw new Error("Support widget identity required.");
    }
    return { asked: question };
  },
  inputSchema: z.strictObject({ question: ASK_TOOL_QUESTION }),
  outputSchema: z.object({ asked: z.string() }),
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) && nextActionEnabled()
        ? tool
        : null,
  },
});
