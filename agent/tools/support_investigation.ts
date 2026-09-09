import { defineDynamic } from "eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { claimFromContext } from "../lib/support/auth.js";
import {
  finishSupportInvestigation,
  finishSupportQuietly,
  openSupportInvestigation,
  reportSupportFailure,
  requireSupportContext,
  skipHandledSupport,
  supportReport,
} from "../lib/support/investigation.js";
import { trackLinkedIssue } from "../lib/support/linear-followup.js";

const tool = defineTool({
  approval: (ctx) =>
    claimFromContext(ctx) && !ctx.session.parent
      ? "not-applicable"
      : { reason: "Scheduled support root only.", type: "denied" },
  description:
    "Open the case and check Intercom plus its linked Linear tickets. Start with open and stop when investigate is false. Track an evidence-matched existing issue with track-issue. Use finish-quietly for checked follow-up changes needing no message, or finish for an actionable internal report; both require the latest revision. Rechecks both sources before delivery to the original notification thread.",
  async execute(input, ctx) {
    try {
      if (input.action === "track-issue") {
        return await trackLinkedIssue(
          ctx,
          requireSupportContext(ctx),
          input.issueId
        );
      }
      if (input.action === "finish-quietly") {
        return await finishSupportQuietly(ctx, input.revision);
      }
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
      action: z.literal("track-issue"),
      issueId: z.string().min(1).max(100),
    }),
    z.object({
      action: z.literal("finish-quietly"),
      revision: z.string().regex(/^[a-f0-9]{64}$/),
    }),
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
