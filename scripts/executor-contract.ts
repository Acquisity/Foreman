import { PROVIDER_CATALOG } from "../agent/lib/executor/catalog.js";
import { providerAllowlist } from "../agent/lib/executor/policy.js";
import {
  EXECUTOR_PROFILES,
  toolkitUrl,
} from "../agent/lib/executor/profiles.js";
import { REQUIRED_HELPER_OPERATIONS } from "../agent/lib/executor/requests.js";

const providers = Object.keys(
  PROVIDER_CATALOG
) as (keyof typeof PROVIDER_CATALOG)[];
const toolkits = ["root", "critic"].flatMap((role) =>
  EXECUTOR_PROFILES.map((profile) => ({
    profile,
    providers: Object.fromEntries(
      providers
        .map((provider) => [
          provider,
          providerAllowlist(provider, role as "root" | "critic", profile),
        ])
        .filter(([, tools]) => (tools as readonly string[]).length > 0)
    ),
    role,
    url: toolkitUrl(role as "root" | "critic", profile),
  }))
);
console.log(
  JSON.stringify(
    {
      helperEndpoints: EXECUTOR_PROFILES.map((profile) =>
        toolkitUrl("helpers", profile)
      ),
      helperOperations: REQUIRED_HELPER_OPERATIONS,
      notes: [
        "These are upstream operation names, not guessed Executor paths. Resolve exact paths and schemas from the installed catalog.",
        "A wildcard preserves the existing provider grant restriction; do not widen provider consent.",
        "Model toolkits must exclude helper-only APIs, raw PlanetScale query/schema tools, Executor management, artifacts, and resume.",
        "Helper endpoints are private to authored code. Retain billing, Instantly and other-provider unattended guards; Linear access is shared across profiles; guessed nested operations must be denied by Executor policy.",
        "Create the Vercel connector and verified operation bindings before enabling traffic.",
      ],
      toolkits,
      version: 1,
    },
    null,
    2
  )
);
