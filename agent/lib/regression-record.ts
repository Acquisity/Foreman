import { defineState } from "eve/context";

/**
 * What the regression check concluded about the code a triage blames
 * (ENG-16056). Only `check_regression` writes one, keyed by ticket, and only
 * `decide_triage` and `save_investigation_document` read it, so a verdict can
 * never rest on a record the model typed in.
 */
export type RegressionKind =
  | "fixed_deploy_unknown"
  | "fixed_live"
  | "fixed_not_deployed"
  | "introduced"
  | "none"
  | "unchecked";

export interface RegressionRecord {
  /** The 40-character commit that introduced or fixed it, when one is named. */
  commit?: string;
  /** The commit Stage 4 read the code at. */
  commitRead: string;
  /** The commit production serves, or null when it could not be established. */
  deployedCommit: string | null;
  /** The blamed file and line range at the commit read: the record answers only for that code. */
  file: string;
  issue: string;
  kind: RegressionKind;
  /** The one result line the investigation document must repeat. */
  line: string;
  lines: { end: number; start: number };
  reason?: string;
  windowDays: number;
}

/**
 * The record for the code a decision blames, or none: a record from another
 * file or another commit read is stale evidence for a corrected investigation.
 */
export const recordFor = (
  record: RegressionRecord | undefined,
  codePath: { commit: string; file: string } | undefined
): RegressionRecord | undefined =>
  record &&
  codePath &&
  record.commitRead === codePath.commit &&
  record.file === codePath.file
    ? record
    : undefined;

/** The part of a record the routing decision needs. */
export type RegressionOutcome = Pick<
  RegressionRecord,
  "commit" | "kind" | "line" | "reason"
>;

export const regressionRecords = defineState<Record<string, RegressionRecord>>(
  "foreman.regressionRecords",
  () => ({})
);
