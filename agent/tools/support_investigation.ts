import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { claimFromContext } from "../lib/support/auth.js";
import {
  finishSupportInvestigation,
  openSupportInvestigation,
  reportSupportFailure,
  skipHandledSupport,
  supportReport,
} from "../lib/support/investigation.js";

const tool = defineTool({
  approval: (ctx) =>
    claimFromContext(ctx) && !ctx.session.parent
      ? "not-applicable"
      : { reason: "Scheduled support root only.", type: "denied" },
  description:
    "Open the scheduled Intercom case, or finish its investigation with the bounded internal Slack report. Start with open and stop when investigate is false. Finish requires the latest revision returned by this tool. It checks the live conversation again and owns delivery to the original notification thread.",
  async execute(input, ctx) {
    try {
      if (input.action === "skip-human-handled") {
        return await skipHandledSupport(ctx);
      }
      return input.action === "open"
        ? await openSupportInvestigation(ctx)
        : await finishSupportInvestigation(ctx, input.report, input.revision);
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return reportSupportFailure(ctx);
    }
  },
  inputSchema: z.discriminatedUnion("action", [
    z.object({ action: z.literal("open") }),
    z.object({ action: z.literal("skip-human-handled") }),
    z.object({
      action: z.literal("finish"),
      report: supportReport,
      revision: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ]),
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) => (claimFromContext(ctx) ? tool : null),
  },
});
