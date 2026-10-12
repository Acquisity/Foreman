import { createGateway } from "ai";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { executorClient } from "#lib/executor/client.js";
import {
  type CostReport,
  costWindow,
  readVercelCharges,
  renderCostReport,
  type SourceSummary,
  summarizeGatewaySpend,
  summarizeVercelCharges,
} from "#lib/foreman-costs.js";
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

/** Per-request deadline for the gateway spend and credit reads. */
const GATEWAY_TIMEOUT_MS = 20_000;

/** The gateway provider on the deployment OIDC token, with every request bounded and cancellable. */
const boundedGateway = (signal: AbortSignal) =>
  createGateway({
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
        ]),
      }),
  });

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
    const window = costWindow(Date.now());
    const signal = ctx.abortSignal;
    const gateway = boundedGateway(signal);
    const [vercel, gatewaySpend, credits] = await Promise.all([
      settle<SourceSummary>(
        async () => {
          const data = await readVercelCharges(
            executorClient(ctx),
            window,
            signal
          );
          return summarizeVercelCharges(data, window);
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
