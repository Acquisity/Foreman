import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  ASK_ERROR,
  ASK_MAX,
  nextActionEnabled,
  validAsk,
} from "../lib/widget-next-action.js";
import { isWidgetSupport } from "../lib/widget-scope.js";

/**
 * Carries a clarify decision to the finish as data. The question is read back
 * from this tool's own result, so nothing depends on how the investigator
 * formats its closing prose. It changes nothing and reads nothing; the question
 * still goes through the ownership scan and the reviewer before the customer
 * sees it. Exists only while the pilot flag is on.
 *
 * The input schema is a shape only: it reaches the model as JSON schema, which
 * cannot carry the contract. `validAsk` is applied here, where the tool runs,
 * and a rejected question comes back as an error the model can correct.
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
    "asks for no file (a screenshot is fine). Returns asked when recorded, or error with " +
    "what to correct.",
  execute({ question }, ctx) {
    if (!isWidgetSupport(ctx.session.auth.initiator)) {
      throw new Error("Support widget identity required.");
    }
    const asked = validAsk(question);
    return asked ? { asked } : { error: ASK_ERROR };
  },
  inputSchema: z.strictObject({ question: z.string().max(ASK_MAX * 4) }),
  outputSchema: z.union([
    z.object({ asked: z.string() }),
    z.object({ error: z.string() }),
  ]),
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) && nextActionEnabled()
        ? tool
        : null,
  },
});
