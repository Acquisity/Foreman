import { gateway } from "ai";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  type CostReport,
  costWindow,
  readVercelCharges,
  renderCostReport,
  type SourceSummary,
  summarizeGatewaySpend,
  summarizeVercelCharges,
} from "#lib/foreman-costs.js";
import { managedConnect } from "#lib/managed-connect.js";
import { isScheduleAppAuth, isTrusted } from "#lib/trust.js";

const reason = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const settle = async <T>(
  work: () => Promise<T>,
  fallback: string,
  signal: AbortSignal
): Promise<T | { error: string }> => {
  try {
    return await work();
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    console.error(fallback, error);
    return { error: reason(error, fallback) };
  }
};

/**
 * App-scoped Vercel access token for the FOCUS billing export, held by a
 * Vercel Connect API-key connector. Resolved lazily so a deployment without
 * the connector still boots and reports the platform side as unavailable.
 */
const vercelApiAuth = () => {
  const connector = process.env.VERCEL_API_CONNECTOR;
  if (!connector) {
    throw new Error("VERCEL_API_CONNECTOR is not set.");
  }
  return managedConnect({ connector, principalType: "app" });
};

export default defineTool({
  description:
    "Read what Foreman cost to run yesterday: AI Gateway model spend and Vercel platform usage for the foreman project, each against its 7-day average, plus the AI Gateway credit balance. Takes no input. The report field is the finished Slack message; post it unchanged. Each source reports its own error instead of failing the whole read.",
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
    const window = costWindow(Date.now());
    const signal = ctx.abortSignal;
    const [vercel, gatewaySpend, credits] = await Promise.all([
      settle<SourceSummary>(
        async () => {
          const { token } = await ctx.getToken(vercelApiAuth());
          const jsonl = await readVercelCharges(token, window, { signal });
          return summarizeVercelCharges(jsonl, window);
        },
        "Vercel billing read could not run.",
        signal
      ),
      settle<SourceSummary>(
        async () => {
          const [byDay, byModel] = await Promise.all([
            gateway.getSpendReport({
              endDate: window.reportDay,
              groupBy: "day",
              startDate: window.firstDay,
            }),
            gateway.getSpendReport({
              endDate: window.reportDay,
              groupBy: "model",
              startDate: window.reportDay,
            }),
          ]);
          return summarizeGatewaySpend(byDay.results, byModel.results, window);
        },
        "AI Gateway spend read could not run.",
        signal
      ),
      settle(
        async () => {
          const { balance, totalUsed } = await gateway.getCredits();
          return { balance: Number(balance), totalUsed: Number(totalUsed) };
        },
        "AI Gateway credits read could not run.",
        signal
      ),
    ]);
    const report: CostReport = {
      credits,
      gateway: gatewaySpend,
      reportDay: window.reportDay,
      vercel,
    };
    return {
      available: true as const,
      data: report,
      report: renderCostReport(report),
    };
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    available: z.boolean(),
    data: z.unknown().optional(),
    reason: z.string().optional(),
    report: z.string().optional(),
  }),
});
