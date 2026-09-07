import { PROVIDER_CATALOG } from "./catalog.js";
import type { ExecutorProfile, ExecutorRole } from "./profiles.js";

export type CompanyProvider = Exclude<
  keyof typeof PROVIDER_CATALOG,
  "supermemory"
>;
const WRITES: Partial<Record<CompanyProvider, readonly string[]>> = {
  openrouter: ["send-message"],
  vercel: [
    "deploy_to_vercel",
    "change_toolbar_thread_resolve_status",
    "reply_to_toolbar_thread",
    "edit_toolbar_message",
    "add_toolbar_reaction",
  ],
};

/** Provisioning contract for Executor's invocation policy, not a discovery-only filter. */
export function providerAllowlist(
  provider: keyof typeof PROVIDER_CATALOG,
  role: ExecutorRole,
  profile: ExecutorProfile
): readonly string[] {
  if (provider === "supermemory") {
    return [];
  }
  if (
    profile === "limited" &&
    !["exa", "inngest", "linear", "lucent", "planetscale"].includes(provider)
  ) {
    return [];
  }
  const allowed: readonly string[] = PROVIDER_CATALOG[provider][role];
  if (
    provider === "intercom" &&
    (profile === "limited" || profile === "scheduled")
  ) {
    return [];
  }
  if (profile === "factory" || profile.startsWith("scheduled")) {
    return allowed.filter((tool) => !WRITES[provider]?.includes(tool));
  }
  return allowed;
}
