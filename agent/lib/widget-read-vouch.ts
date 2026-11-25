// ENG-20659: a reply naming youtube.com from the workspace's own Knowledge
// Base was blocked as a foreign identifier. An identifier that a read scoped
// to this verified workspace returned is the workspace's own, so the reply may
// name it, as it may name what the customer typed. Only reads whose whole
// result is the workspace's own data vouch, and a value marked diagnosis only
// can hold raw provider text, so it never does.
import { vouchedBy } from "./widget-egress.js";
import { ENDPOINT_TOOL_NAMES } from "./widget-endpoint-tools.js";
import type { IdentifierCandidates } from "./widget-evidence.js";

/**
 * Hand-written tools whose every query is filtered to the verified
 * organization, so their result holds only its data. Left out on purpose:
 * widget_account_access (its Sentry read is per user, across workspaces),
 * widget_billing_summary (a billing account can cover sibling workspaces),
 * widget_job_failures (raw error text), widget_sdr_thread_status (the host's
 * calendars from other workspaces), widget_website_status (build logs and
 * public DNS), widget_provider (any query), and known issues, help articles,
 * recordings and ticket filing. A new tool vouches for nothing until it is
 * added here.
 */
const SCOPED_TOOLS: ReadonlySet<string> = new Set([
  "widget_crm_contact",
  "widget_generation_diagnostics",
  "widget_inbox_health",
  "widget_lead_pipeline_status",
  "widget_outreach_health",
  "widget_provisioning_status",
]);

/**
 * Acquisity's endpoint tools are scoped to the verified workspace by its
 * handler. Billing reads by billing account, which can cover sibling
 * workspaces, so it vouches for nothing.
 */
const vouchesFor = (tool: string) =>
  SCOPED_TOOLS.has(tool) ||
  (ENDPOINT_TOOL_NAMES.has(tool) && tool !== "widget_billing");

export const NOTHING_VOUCHED: Required<IdentifierCandidates> = {
  domains: [],
  emails: [],
  slugs: [],
  uuids: [],
};

/** Every identifier either set vouches for, each once. */
export const addVouched = (
  so: Required<IdentifierCandidates>,
  more: Required<IdentifierCandidates>
): Required<IdentifierCandidates> => ({
  domains: [...new Set([...so.domains, ...more.domains])],
  emails: [...new Set([...so.emails, ...more.emails])],
  slugs: [...new Set([...so.slugs, ...more.slugs])],
  uuids: [...new Set([...so.uuids, ...more.uuids])],
});

const withoutDiagnosisOnly = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(withoutDiagnosisOnly);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if ((value as { diagnosisOnly?: unknown }).diagnosisOnly === true) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      withoutDiagnosisOnly(child),
    ])
  );
};

/**
 * The identifiers one tool result vouches for: none unless it is a vouching
 * read that answered status "ok". A refusal or unavailable answer is not an
 * error result, so the status is checked too.
 */
export function workspaceReadIdentifiers(
  result: unknown
): Required<IdentifierCandidates> {
  const action = result as {
    isError?: boolean;
    kind?: string;
    output?: { status?: unknown } | null;
    toolName?: unknown;
  } | null;
  if (
    action?.kind !== "tool-result" ||
    action.isError === true ||
    typeof action.toolName !== "string" ||
    !vouchesFor(action.toolName) ||
    action.output?.status !== "ok"
  ) {
    return NOTHING_VOUCHED;
  }
  return vouchedBy(JSON.stringify(withoutDiagnosisOnly(action.output)));
}
