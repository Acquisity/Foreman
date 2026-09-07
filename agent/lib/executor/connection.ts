import {
  ConnectionAuthorizationFailedError,
  defineMcpClientConnection,
} from "eve/connections";
import { executorAuth } from "./auth.js";
import {
  connectionName,
  type ExecutorProfile,
  type ExecutorRole,
  executorProfile,
  toolkitUrl,
} from "./profiles.js";

/** Eve 0.44 requires a static URL. Each slot has both an auth gate and a call gate. */
export function executorConnection(
  role: ExecutorRole,
  profile: ExecutorProfile
) {
  return defineMcpClientConnection({
    approval: (ctx) =>
      executorProfile(ctx.session.auth.current) === profile &&
      ["execute", "skills"].some(
        (name) => ctx.toolName === name || ctx.toolName.endsWith(`__${name}`)
      )
        ? "not-applicable"
        : {
            reason: "This Executor profile is not available to this session.",
            type: "denied",
          },
    auth: (ctx) => {
      if (executorProfile(ctx.session.auth.current) !== profile) {
        throw new ConnectionAuthorizationFailedError(connectionName(profile), {
          message: "This Executor profile is not available to this session.",
          reason: "executor_profile_denied",
          retryable: false,
        });
      }
      return executorAuth();
    },
    description: `Executor company services for the ${role}, ${profile} profile. Discover provider tools inside execute using tools.search and tools.describe.tool. Custom Foreman helpers remain separate. Personal Supermemory is separate.`,
    tools: { allow: ["execute", "skills"] },
    url: toolkitUrl(role, profile),
  });
}
