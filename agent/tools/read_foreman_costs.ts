import { defineTool } from "eve/tools";
import { z } from "zod";
import { executorClient } from "#lib/executor/client.js";
import { readCostReport, renderCostReport } from "#lib/foreman-costs.js";
import { isScheduleAppAuth, isTrusted } from "#lib/trust.js";

export default defineTool({
  description:
    "Read what Foreman cost to run yesterday: AI Gateway model spend and Vercel platform usage for the foreman project, each against its 7-day average, plus the AI Gateway credit balance and the paid sources it cannot read. Takes no input. The report field is the finished Slack message; post it unchanged. Each source reports its own error instead of failing the whole read.",
  async execute(_input, ctx) {
    const auth = ctx.session.auth.current;
    // Trusted covers Slack and Linear; the schedule runs as the app; the
    // local-dev principal only exists on a dev server.
    if (
      !(
        isTrusted(auth) ||
        isScheduleAppAuth(auth) ||
        auth?.authenticator === "local-dev"
      )
    ) {
      return {
        available: false as const,
        reason: "This session is not authorized to read Foreman's costs.",
      };
    }
    const report = await readCostReport(executorClient(ctx), ctx.abortSignal);
    return {
      available: true as const,
      report: renderCostReport(report),
    };
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    available: z.boolean(),
    reason: z.string().optional(),
    report: z.string().optional(),
  }),
});
