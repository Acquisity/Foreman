import { ConnectionAuthorizationFailedError } from "eve/connections";
import { managedConnect } from "../managed-connect.js";

/** The connector is provisioned and attached separately, before cutover. */
export function executorAuth() {
  const connector = process.env.EXECUTOR_MCP_CONNECTOR;
  if (!connector) {
    throw new ConnectionAuthorizationFailedError("executor", {
      message:
        "Executor is not configured for Foreman. This source is unavailable; do not retry or request provider sign-in.",
      reason: "executor_not_configured",
      retryable: false,
    });
  }
  return managedConnect({ connector, principalType: "app" });
}
