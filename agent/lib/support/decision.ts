import type { SupportRow } from "./store.js";

export interface SupportObservation {
  closed: boolean;
  hasLinkedIssues: boolean;
  snoozed: boolean;
  version: string;
}
export type SupportDecision =
  | { kind: "closed" | "pending-delivery" | "reconcile" }
  | { kind: "unchanged"; discardReport: boolean; processed: boolean }
  | { kind: "investigate"; discardReport: boolean };

export const pendingFailureReport = (
  row: Pick<SupportRow, "report" | "report_kind">
) => Boolean(row.report) && row.report_kind === "failure";

/** Pure precedence rules. Effects and provider reads belong to the orchestrator. */
export function decideSupport(
  row: Pick<
    SupportRow,
    "report" | "delivery_attempted" | "version" | "processed_version"
  >,
  current: SupportObservation
): SupportDecision {
  if (row.report && row.delivery_attempted) {
    return { kind: "reconcile" };
  }
  if (current.closed) {
    return { kind: "closed" };
  }
  if (row.report && row.version === current.version) {
    return { kind: "pending-delivery" };
  }
  const discardReport = row.report !== null;
  if (current.version === row.processed_version) {
    return { discardReport, kind: "unchanged", processed: false };
  }
  if (current.snoozed && !current.hasLinkedIssues) {
    return { discardReport, kind: "unchanged", processed: true };
  }
  return { discardReport, kind: "investigate" };
}
