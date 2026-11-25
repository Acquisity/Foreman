// ENG-20659: a reply naming youtube.com from the workspace's own Knowledge
// Base was blocked as a foreign identifier. An identifier a read of this
// verified workspace returned is the workspace's own, so the reply may name it,
// as it may name what the customer typed. Known issues (other customers'
// tickets), help articles, recordings and ticket filing are not workspace
// reads, and a value marked diagnosis only can hold raw provider text, so none
// of those vouches for anything.
import { isWorkspaceRead } from "./widget-capability-gaps.js";

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
    !isWorkspaceRead(action.toolName)
  ) {
    return "";
  }
  return JSON.stringify(withoutDiagnosisOnly(action.output ?? null)) ?? "";
}
