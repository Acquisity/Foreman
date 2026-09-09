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
export const toolkitUrl = (slug = FOREMAN_TOOLKIT_SLUG): string => {
  if (slug !== FOREMAN_TOOLKIT_SLUG && slug !== "foreman-support") {
    throw new Error("Unknown Foreman toolkit.");
  }
  return `${executorOrigin()}/mcp/toolkits/${slug}?artifacts=false`;
};
