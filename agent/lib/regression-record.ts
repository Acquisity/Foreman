import { defineState } from "eve/context";
import { repositoryPath } from "./regression-lane.js";

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
  /** The failure time the check judged a fix against. */
  failureAt: string;
  /** The blamed file and line range at the commit read: the record answers only for that code. */
  file: string;
  /** The function the blamed range sits in, as decide_triage's codePath names it. */
  function: string;
  issue: string;
  kind: RegressionKind;
  /** The one result line the investigation document must repeat. */
  line: string;
  lines: { end: number; start: number };
  reason?: string;
  windowDays: number;
}

/**
 * The record for the code a decision blames, or none: a record for any other
 * file, function, line range, commit read or failure time is stale evidence
 * for a corrected investigation, and a codePath without its line range or a
 * decision without the failure time matches nothing.
 */
export const recordFor = (
  record: RegressionRecord | undefined,
  codePath:
    | {
        commit: string;
        file: string;
        function: string;
        lines?: { end: number; start: number };
      }
    | undefined,
  failureAt: string | undefined
): RegressionRecord | undefined =>
  record &&
  codePath?.lines &&
  failureAt !== undefined &&
  Number.isFinite(Date.parse(failureAt)) &&
  Date.parse(record.failureAt) === Date.parse(failureAt) &&
  record.commitRead === codePath.commit &&
  record.file === repositoryPath(codePath.file) &&
  record.function === codePath.function &&
  record.lines.start === codePath.lines.start &&
  record.lines.end === codePath.lines.end
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
