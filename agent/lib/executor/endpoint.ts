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
// path in the shared toolkit and cannot filter per operation, so the write
// lives here, where no lane, delegate, critic, or schedule has the slug.
export const DISPUTES_TOOLKIT = "foreman-disputes";
export type ExecutorToolkit =
  | typeof FOREMAN_TOOLKIT_SLUG
  | typeof SUPPORT_TOOLKIT
  | typeof DISPUTES_TOOLKIT;
export const toolkitUrl = (
  slug: ExecutorToolkit = FOREMAN_TOOLKIT_SLUG
): string => {
  if (
    slug !== FOREMAN_TOOLKIT_SLUG &&
    slug !== SUPPORT_TOOLKIT &&
    slug !== DISPUTES_TOOLKIT
  ) {
    throw new Error("Unknown Foreman toolkit.");
  }
  return `${executorOrigin()}/mcp/toolkits/${slug}?artifacts=false`;
};
