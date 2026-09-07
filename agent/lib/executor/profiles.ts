import type { SessionAuthContext } from "eve/context";
import {
  canUseInvestigationMemory,
  isAutonomous,
  isTrusted,
  isUnattended,
} from "../trust.js";

export const EXECUTOR_PROFILES = [
  "attended",
  "limited",
  "factory",
  "scheduled",
  "scheduled-internal",
] as const;
export type ExecutorProfile = (typeof EXECUTOR_PROFILES)[number];
export type ExecutorRole = "root" | "critic";

/** Choose privileges only from dispatch-owned stamps, never tool arguments. */
export function executorProfile(
  auth: SessionAuthContext | null
): ExecutorProfile {
  if (isAutonomous(auth)) {
    return "factory";
  }
  const internal = isTrusted(auth) || canUseInvestigationMemory(auth);
  if (isUnattended(auth)) {
    return internal ? "scheduled-internal" : "scheduled";
  }
  return internal ? "attended" : "limited";
}

export function executorOrigin(): string {
  const url = new URL(
    process.env.EXECUTOR_BASE_URL ?? "https://executor.acquisity.ai"
  );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "EXECUTOR_BASE_URL must be an HTTPS origin without credentials, path, or query."
    );
  }
  return url.origin;
}

export const toolkitUrl = (
  role: ExecutorRole | "helpers",
  profile: ExecutorProfile
): string =>
  `${executorOrigin()}/mcp/toolkits/foreman-${role}-${profile}?artifacts=false`;

export const connectionName = (profile: ExecutorProfile): string =>
  profile === "attended" ? "executor" : `executor-${profile}`;
