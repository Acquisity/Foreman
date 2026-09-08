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
export const toolkitUrl = (): string =>
  `${executorOrigin()}/mcp/toolkits/${FOREMAN_TOOLKIT_SLUG}?artifacts=false`;
