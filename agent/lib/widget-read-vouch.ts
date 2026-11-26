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
 * Acquisity's endpoint tools are scoped to the verified workspace by its
 * handler, so their results vouch. Billing reads by billing account, which can
 * cover sibling workspaces, so it vouches for nothing, and neither do known
 * issues, help articles, recordings or ticket filing.
 */
const vouchesFor = (tool: string) =>
  ENDPOINT_TOOL_NAMES.has(tool) && tool !== "widget_billing";

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
