import { getToken as getConnectToken } from "@vercel/connect";
import type { ProviderContext } from "./dispatch.js";
import { ExecutorError } from "./transport.js";

/**
 * Executor access for a schedule that runs outside any eve session: every
 * call uses the app principal's token from the Executor connector.
 */
export const appProviderContext = (
  abortSignal: AbortSignal
): ProviderContext => ({
  abortSignal,
  getToken: async () => {
    const connector = process.env.EXECUTOR_MCP_CONNECTOR;
    if (!connector) {
      throw new ExecutorError("executor_not_configured");
    }
    return {
      token: await getConnectToken(connector, { subject: { type: "app" } }),
    };
  },
});
