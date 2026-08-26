/**
 * Product scope for investigation memory: the stable feature keys a case is
 * filed under, and the Linear projects that resolve to them.
 *
 * @remarks
 * For a ticketed case, the evidence-backed Linear project saved during final
 * triage handling is the only primary-feature authority. Nothing here reads a
 * symptom, a title, a repository, or an environment variable, and a project
 * that is not listed stays unscoped and the case is not recorded. A ticketless
 * Intercom or Slack case has no project, so the model names a live area
 * directly; the enum is the bound, and a memory row's bucket routes nothing.
 * Retrieval never consults this mapping.
 *
 * Keys are stable identifiers, not display names. Renaming a product is a
 * change to `label` here, never to the key stored in a case row.
 */

/** The tenant every case is filed under. Server-derived, never model input. */
export const TENANT_KEY = "acquisity";

/** Stable feature keys, one per owning product area. */
export const FEATURE_KEYS = [
  "cold_email",
  "domains_inboxes",
  "ai_sdr",
  "crm",
  "website_builder",
  "core_platform",
  "acquisity_agent",
  "support",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

const FEATURE_KEY_SET = new Set<string>(FEATURE_KEYS);

/** One product area: its display name and whether it is live yet. */
export interface Feature {
  readonly label: string;
  readonly lifecycle: "live" | "planned";
}

/**
 * The areas cases are filed under, matching the triage skill's area-routing
 * roster. `acquisity_agent` is carried as planned: tickets exist under its
 * Linear project, but the product is not live, so a match from it is a
 * pre-release signal rather than a customer-impact analogy.
 *
 * Shopify Store Builder is deliberately absent. It is not live and is no
 * longer part of Acquisity.
 *
 * `support` is the ENG `Support` project as an evidence-backed final project:
 * config mismatches, workspace setup, account and billing follow-ups, and
 * cases support closes without engineering. It is live so those cases record
 * and recall like any other area. The incoming `Support` project still gates
 * nothing; only the project saved after the investigation scopes a write.
 *
 * `domains_inboxes` is its own area rather than part of `cold_email`. The
 * tickets there are provisioning and purchase failures (orders that never
 * provision, domains stuck in error, orphaned inboxes, checkout and refund
 * confusion), not campaign sending behavior. Folding them into cold email
 * would mix "the domain never provisioned" analogies with "the campaign
 * stopped sending" ones, which is the opposite of what retrieval needs. A
 * case that spans both records the other side as an affected feature.
 */
export const FEATURES: Readonly<Record<FeatureKey, Feature>> = {
  acquisity_agent: { label: "Acquisity Agent", lifecycle: "planned" },
  ai_sdr: { label: "AI SDR", lifecycle: "live" },
  cold_email: { label: "Cold Email", lifecycle: "live" },
  core_platform: { label: "Core Platform", lifecycle: "live" },
  crm: { label: "CRM", lifecycle: "live" },
  domains_inboxes: { label: "Domains & Inboxes", lifecycle: "live" },
  support: { label: "Support", lifecycle: "live" },
  website_builder: { label: "Website Builder", lifecycle: "live" },
};

/**
 * Product areas that every authorized attended triage surface searches.
 *
 * @remarks
 * This list is server-owned rather than model input. It deliberately includes
 * every live area and excludes planned areas such as Acquisity Agent. Keeping
 * the list derived from the lifecycle table makes a product launch the only
 * change needed to make its historical cases eligible for global
 * recall.
 */
export const LIVE_FEATURE_KEYS: readonly FeatureKey[] = Object.freeze(
  FEATURE_KEYS.filter((key) => FEATURES[key].lifecycle === "live")
);

/**
 * Linear project id to owning feature.
 *
 * @remarks
 * Only projects whose owning area has been decided are mapped. Several live
 * projects (Onboarding Flow, Workflows, Public API, Acquisity Ingress, the AI
 * Ads projects, Whitelabel Partners) plausibly sit under one of these areas,
 * but assigning them would be the inference this design exists to prevent, so
 * they stay unmapped until someone decides where they belong. An unmapped final
 * project is not an error: the case is simply not recorded, and the completed
 * investigation stands. The SAN sandbox `Support` project
 * (`e3479f03-e840-4f72-864e-fc956c7934d6`) stays unmapped on purpose: sandbox
 * tickets are test traffic, and a case from one is not a customer analogy.
 *
 * Ids are Linear project ids, which are stable across renames.
 */
export const LINEAR_PROJECT_FEATURES: Readonly<Record<string, FeatureKey>> = {
  "1ae59086-e924-42d1-b7ff-f9c750a2a7c9": "cold_email", // Cold Email Agent
  "2d1ef833-7012-487d-b257-ff4eced47feb": "crm", // CRM Calendar Scheduling
  "9c0e091f-9a09-4978-a096-f6b8943a1718": "ai_sdr", // AI SDR Escalation & Classification
  "9c27321a-6027-499c-9235-7c3fcc3e0cd8": "crm", // CRM
  "9f2e1f4a-f878-4481-96f8-3eb15f048390": "domains_inboxes", // Domains & Inboxes
  "33cd50d6-bf41-4133-89e5-a349346f4479": "acquisity_agent", // Acquisity Agent
  "50a332cc-402c-4abf-961f-4cdd05f9afdf": "cold_email", // Cold Email Leads
  "52fa1548-6f61-4732-8afc-20891168f91c": "cold_email", // Cold Email Core
  "313fb32a-67a4-4e03-a08d-5d264971486b": "ai_sdr", // AI SDR v1 (completed)
  "2484b203-9b4e-46f6-9848-9a059501280e": "core_platform", // Core Platform
  "4534deb2-6bbc-4e30-ad38-48963f414d14": "support", // Support (ENG)
  "8201ed14-2417-48bc-9f53-d84fb3ad81cd": "website_builder", // AI Website Builder
  "331512fc-5734-4fa0-92a5-a9b5a85d965b": "ai_sdr", // AI SDR Inbox & UI
  "a69b5b38-19bf-4596-8e1f-d1dafb9fe1e2": "ai_sdr", // AI SDR Scheduling
  "a42533a8-19b4-4300-a501-815a8e5f4774": "crm", // CRM Phone Calling & Texting
  "bcbb1c6f-9f9d-4eea-b6ac-599a0dc08713": "ai_sdr", // AI SDR Core
};

/**
 * The feature a Linear project belongs to, or null when the project is not
 * mapped. Never guesses.
 */
export function featureForProject(
  linearProjectId: string | null | undefined
): FeatureKey | null {
  if (typeof linearProjectId !== "string") {
    return null;
  }
  // Own-property check, not a bare index: a plain object literal still
  // inherits `constructor`, `toString`, and friends, and a lookup for one of
  // those names would return a truthy function that `?? null` never catches.
  const key = linearProjectId.toLowerCase();
  return Object.hasOwn(LINEAR_PROJECT_FEATURES, key)
    ? LINEAR_PROJECT_FEATURES[key]
    : null;
}

/** Whether a model-supplied string is one of the known feature keys. */
export function isFeatureKey(value: string): value is FeatureKey {
  return FEATURE_KEY_SET.has(value);
}

/** A Linear issue identifier such as `ENG-12345`. */
export const LINEAR_ISSUE_ID_PATTERN = /^[A-Z]{2,10}-\d{1,9}$/;

/** Whether a source id names a Linear ticket rather than a ticketless source. */
export const isLinearSource = (sourceIssueId: string): boolean =>
  LINEAR_ISSUE_ID_PATTERN.test(sourceIssueId);

/**
 * Why a write had no product area to file under. Shared by the record and
 * correct tools; it lives here so neither tool module imports the other.
 */
export const NO_FEATURE_REASON =
  "The case has no owning product area, so it is not recorded and the investigation itself stands. A Linear-sourced case takes its area only from a mapped Linear project. A ticketless Intercom or Slack case needs a live product area in primaryFeatureKey and ignores any project id.";

/**
 * The primary feature a case write files under, or null when it has none.
 *
 * @remarks
 * The shape of the source id decides the authority, not which fields the
 * model chose to send. A Linear ticket resolves only through its mapped
 * project, so it cannot pick its own bucket by omitting the project id. A
 * ticketless Intercom or Slack source has no project, so the model's key
 * stands, bounded to the live areas: a planned area has no customer-impact
 * analogies to file, and a case there would be found by nothing.
 */
export function featureForCase(source: {
  linearProjectId?: string | null;
  primaryFeatureKey?: FeatureKey | null;
  sourceIssueId: string;
}): FeatureKey | null {
  if (isLinearSource(source.sourceIssueId)) {
    return featureForProject(source.linearProjectId);
  }
  const key = source.primaryFeatureKey ?? null;
  return key !== null && LIVE_FEATURE_KEYS.includes(key) ? key : null;
}

/** Maximum dependency or affected-feature entries on one case. */
export const MAX_SCOPE_ENTRIES = 8;

/**
 * Shared systems a case can be tagged with (`instantly`, `webhooks`,
 * `inngest`, `authentication`, `billing`, ...).
 *
 * @remarks
 * Deliberately an open vocabulary bounded by shape rather than a closed enum:
 * the set of shared systems changes faster than this file would, and a
 * dependency key is a retrieval hint, never an authorization decision. The
 * pattern keeps them stable, lowercase, and short enough to index.
 */
const DEPENDENCY_KEY_PATTERN = /^[a-z0-9][a-z0-9_]{1,39}$/;

/** Whether a model-supplied dependency key has the required stable shape. */
export function isDependencyKey(value: string): boolean {
  return DEPENDENCY_KEY_PATTERN.test(value);
}
