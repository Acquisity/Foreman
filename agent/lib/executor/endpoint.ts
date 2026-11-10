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
// Each lane is one Executor v2 scoped connection. Its ID is chosen when the
// connection is created; IDs are unique per Executor instance, so Preview and
// Production can set their own. Unset or empty uses the lane name.
const CONNECTION_ENV = {
  [DISPUTES_TOOLKIT]: "EXECUTOR_CONNECTION_DISPUTES",
  [FOREMAN_TOOLKIT_SLUG]: "EXECUTOR_CONNECTION_FOREMAN",
  [SUPPORT_TOOLKIT]: "EXECUTOR_CONNECTION_SUPPORT",
} as const;
const CONNECTION_ID = /^[A-Za-z0-9_-]{1,64}$/u;
export const toolkitUrl = (
  slug: ExecutorToolkit = FOREMAN_TOOLKIT_SLUG
): string => {
  if (!Object.hasOwn(CONNECTION_ENV, slug)) {
    throw new Error("Unknown Foreman toolkit.");
  }
  const id = process.env[CONNECTION_ENV[slug]] || slug;
  if (!CONNECTION_ID.test(id)) {
    throw new Error(
      `${CONNECTION_ENV[slug]} must be an Executor connection ID.`
    );
  }
  return `${executorOrigin()}/mcp?connection=${id}`;
};
