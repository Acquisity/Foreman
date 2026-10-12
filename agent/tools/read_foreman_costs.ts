import { createGateway } from "ai";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { executorClient } from "#lib/executor/client.js";
import {
  type CostReport,
  CostSourceError,
  costWindow,
  readVercelCharges,
  renderCostReport,
  type SourceSummary,
  summarizeGatewaySpend,
} from "#lib/foreman-costs.js";
import { isScheduleAppAuth, isTrusted } from "#lib/trust.js";

const reason = (error: unknown, fallback: string): string => {
  // SDK errors wrap HTTP and deadline failures in causes. Inspect only fixed
  // names and numeric statuses, never provider messages or response bodies.
  let cause = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (cause instanceof CostSourceError) {
      return cause.reason;
    }
    if (typeof cause !== "object" || cause === null) {
      break;
    }
    const failure = cause as {
      name?: unknown;
      statusCode?: unknown;
      status?: unknown;
      cause?: unknown;
    };
    if (failure.name === "TimeoutError" || failure.name === "AbortError") {
      return "timed out";
    }
    const status = failure.statusCode ?? failure.status;
    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
    ) {
      return `HTTP ${status}`;
    }
    ({ cause } = failure);
  }
  return fallback;
};

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
    console.error(fallback);
    return { error: reason(error, fallback) };
  }
};

/** Per-request deadline for the gateway spend and credit reads. */
const GATEWAY_TIMEOUT_MS = 20_000;

/** The gateway provider with standard auth (AI_GATEWAY_API_KEY, else deployment OIDC), with every request bounded and cancellable. */
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
        async () => readVercelCharges(executorClient(ctx), window, signal),
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
          const { balance } = await gateway.getCredits();
          return { balance: Number(balance) };
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
