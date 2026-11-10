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

export const FOREMAN_TOOLKIT_SLUG = "foreman";
export const SUPPORT_TOOLKIT = "foreman-support";
// The in-app support widget lane reuses the deployed support read toolkit; its
// own curated read allowlist (WIDGET_PATHS) still narrows what it may call.
export const WIDGET_TOOLKIT = SUPPORT_TOOLKIT;
// Holds only the Stripe dispute evidence write and file upload (ENG-16255).
// Only respond_stripe_dispute reaches it: the raw execute gateway runs any
// path the foreman bot can reach and cannot filter per operation, so the write
// apps are shared only with the disputes bot, whose connector no other lane uses.
export const DISPUTES_TOOLKIT = "foreman-disputes";
/** Every lane, once; the lane type, this check and the connector map in auth.ts derive from it. */
export const LANES = [
  DISPUTES_TOOLKIT,
  FOREMAN_TOOLKIT_SLUG,
  SUPPORT_TOOLKIT,
] as const;
export type ExecutorToolkit = (typeof LANES)[number];
// Every lane uses the same plain MCP URL: a lane is isolated by its bot's
// token (agent/lib/executor/auth.ts), and v2 ignores `?connection=` for tokens.
export const toolkitUrl = (
  slug: ExecutorToolkit = FOREMAN_TOOLKIT_SLUG
): string => {
  if (!(LANES as readonly string[]).includes(slug)) {
    throw new Error("Unknown Foreman toolkit.");
  }
  return `${executorOrigin()}/mcp`;
};
