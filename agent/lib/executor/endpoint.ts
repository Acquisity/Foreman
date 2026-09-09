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
export type ExecutorToolkit =
  | typeof FOREMAN_TOOLKIT_SLUG
  | typeof SUPPORT_TOOLKIT;
export const toolkitUrl = (
  slug: ExecutorToolkit = FOREMAN_TOOLKIT_SLUG
): string => {
  if (slug !== FOREMAN_TOOLKIT_SLUG && slug !== SUPPORT_TOOLKIT) {
    throw new Error("Unknown Foreman toolkit.");
  }
  return `${executorOrigin()}/mcp/toolkits/${slug}?artifacts=false`;
};
