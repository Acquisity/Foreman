// ENG-20659: a reply naming youtube.com from the workspace's own Knowledge
// Base was blocked as a foreign identifier. An identifier that a read scoped
// to this verified workspace returned is the workspace's own, so the reply may
// name it, as it may name what the customer typed. Only reads whose whole
// result is the workspace's own data vouch, and a value marked diagnosis only
// can hold raw provider text, so it never does.
import { ENDPOINT_TOOL_NAMES } from "./widget-endpoint-tools.js";

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

/** Enough for every read a turn makes; the egress scan stops at its own bound. */
export const VOUCHED_TEXT_MAX = 256 * 1024;

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

/** The text of one tool result that vouches for its identifiers, or "" when it vouches for none. */
export function workspaceReadText(result: unknown): string {
  const action = result as {
    isError?: boolean;
    kind?: string;
    output?: unknown;
    toolName?: unknown;
  } | null;
  if (
    action?.kind !== "tool-result" ||
    action.isError === true ||
    typeof action.toolName !== "string" ||
    !vouchesFor(action.toolName)
  ) {
    return "";
  }
  return JSON.stringify(withoutDiagnosisOnly(action.output ?? null)) ?? "";
}
