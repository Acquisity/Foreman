// Every app slug in the root toolkit manifest, with the service it reaches. v2
// slugs differ from provider names (planetscale-org, sentry-foreman), and a
// guessed namespace returns nothing, which reads as a missing source.
// executor-namespaces.test.ts keeps this equal to the manifest.
export const EXECUTOR_NAMESPACES = {
  Autumn: ["autumn-foreman", "foreman-autumn-api"],
  Axiom: ["axiom-foreman"],
  Exa: ["exa"],
  "Help Center": ["foreman-help-api"],
  Inngest: ["inngest", "foreman-inngest-api"],
  Instantly: ["foreman-instantly-api"],
  Intercom: ["intercom"],
  Jam: ["jam-foreman"],
  Linear: [
    "linear-foreman",
    "foreman-linear-read-api",
    "foreman-linear-write-api",
  ],
  Lucent: ["lucent"],
  Modem: ["modem-foreman"],
  "Neon (read-only)": ["neon-readonly"],
  OpenRouter: ["openrouter"],
  PlanetScale: ["planetscale-org"],
  PostHog: ["posthog-foreman"],
  Raindrop: ["raindrop"],
  Resend: ["resend"],
  Sentry: ["sentry-foreman"],
  "Slack (AI Acquisition workspace)": ["foreman-aia-slack-api"],
  Stripe: [
    "stripe-foreman",
    "foreman-stripe-api",
    "foreman-stripe-api-sandbox",
  ],
  Vercel: ["foreman-vercel-api", "foreman-vercel-billing-api"],
} as const;

const namespaceList = Object.entries(EXECUTOR_NAMESPACES)
  .map(([service, slugs]) => `${service}: ${slugs.join(", ")}`)
  .join("; ");

export const EXECUTOR_DISCOVERY = `Company-service tools are discovered through Executor. Use eve__search with a query that starts with executor__, which searches only the executor connection, and call what it returns with eve__tool; never search every connection. Within execute, search one app with tools.search({ namespace, query }), where namespace is the app slug, inspect the returned path with tools.search.describe({ paths: [path] }), then call the exact expression search returned, such as tools["foreman-stripe-api"].customers.readCustomer(input). The app slugs are exactly these, and many differ from the provider name:${namespaceList}. Use these slugs as namespaces; never guess one. An empty result from a listed namespace means the query missed, so search it again with other words or with no query. To list a namespace or all tools, follow the returned next object until it is null; the first page is not the whole list. A call returns the provider's data and throws when it fails, so wrap each call in try/catch. Use only paths returned by discovery, never translate an old qualified name into a guessed path. Do not call Executor management, artifact, or resume tools. Do not retry a denied or unavailable source this turn; record the evidence gap and continue the task. Authored Foreman helpers are called by their bare names without discovery; use them for bounded queries, billing, Instantly, run searches, and routing.`;
