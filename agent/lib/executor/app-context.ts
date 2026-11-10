import { getToken as getConnectToken } from "@vercel/connect";
import { authLane, laneConnector } from "./auth.js";
import type { ProviderContext } from "./dispatch.js";
import { ExecutorError } from "./transport.js";

/**
 * Executor access for a schedule that runs outside any eve session: each call
 * uses the app token of the connector for the lane it asked for, never another.
 */
export const appProviderContext = (
  abortSignal: AbortSignal
): ProviderContext => ({
  abortSignal,
  getToken: async (auth: unknown) => {
    const lane = authLane(auth);
    const connector = lane && laneConnector(lane);
    if (!connector) {
      throw new ExecutorError("executor_not_configured");
    }
    return {
      token: await getConnectToken(connector, { subject: { type: "app" } }),
    };
  },
});
