import type {
  DuplicateMatch,
  HandlingPath,
  TriageClassification,
  TriageInput,
} from "./jev-decisions.js";
import type { RegressionKind } from "./regression-record.js";

/**
 * A Bug main already fixes is not new engineering work (ENG-16056). Fixed
 * and live closes as Done, because the earlier fix is the change that was
 * made; a fix production does not serve yet goes to the area owner while the
 * customer's ticket stays open.
 */
export interface FixedRouting {
  note: string;
  /** The area owner holds the ticket until the fix is live. */
  ownerFollowUp: boolean;
  path: HandlingPath;
}

const FIXED_PATHS: Partial<Record<RegressionKind, FixedRouting>> = {
  fixed_deploy_unknown: {
    note: "Already fixed on main, but what production serves could not be established: the area owner confirms it is live. No master and no engineering hand-off.",
    ownerFollowUp: true,
    path: "Support/Product follow-up",
  },
  fixed_live: {
    note: "Already fixed on main and live: resolved by the named commit. No master and no engineering hand-off.",
    ownerFollowUp: false,
    path: "Resolved by triage",
  },
  fixed_not_deployed: {
    note: "Already fixed on main, not deployed yet: the area owner gets the fixing commit and the customer's ticket stays open until the deploy. No master and no engineering hand-off.",
    ownerFollowUp: true,
    path: "Support/Product follow-up",
  },
};

export const fixedRouting = (
  input: TriageInput,
  classification: TriageClassification,
  duplicate: boolean,
  notes: string[]
): FixedRouting | undefined => {
  const fixed =
    classification === "Bug" && !duplicate && input.regression
      ? FIXED_PATHS[input.regression.kind]
      : undefined;
  if (fixed) {
    notes.push(`${fixed.note} Fixing commit: ${input.regression?.commit}.`);
  }
  return fixed;
};

/** The path before the change-evidence check: billing, then a duplicate, then a fixed record, then Jev's choice. */
export const routedPath = (
  billed: boolean,
  match: DuplicateMatch,
  choice: string,
  fixedPath?: HandlingPath
): HandlingPath => {
  if (billed) {
    return "Support/Financial";
  }
  if (match) {
    return "Duplicate";
  }
  return fixedPath ?? (choice as HandlingPath);
};

/** A staff or triage action that changed something for this customer, as recorded on the ticket. */
export interface ChangeMade {
  action: string;
  by: "staff" | "triage";
  /** The Linear comment or document on this ticket that records it. */
  recordedAt: string;
}

const recordedOn = (identifier: string, url: string): boolean => {
  const match = LINEAR_ISSUE_URL.exec(url.trim());
  return match?.[1]?.toUpperCase() === identifier.toUpperCase();
};
const LINEAR_ISSUE_URL =
  /^https:\/\/linear\.app\/[\w-]+\/issue\/([A-Za-z]+-\d+)(?:[/?#]|$)/u;

export const CHANGE_GAP =
  "Evidence of the change that resolved it: a fix live in production (check_regression returns fixed on main and live) or the staff or triage action, passed as changeMade with the link to where this ticket records it. An explanation with no change is not Resolved by triage.";

/**
 * Resolved by triage closes Done, so it needs evidence that something changed
 * (ENG-16608): a fix production serves, or a staff or triage action recorded
 * on this ticket. Without one, an explanation closes as the User Error or
 * Platform Limitation it is, Canceled, and a Bug has not been shown resolved.
 */
export const resolvedPath = (
  input: TriageInput,
  classification: TriageClassification,
  path: HandlingPath,
  notes: string[]
): { path: HandlingPath } | { missing: string[] } => {
  if (
    path !== "Resolved by triage" ||
    input.regression?.kind === "fixed_live"
  ) {
    return { path };
  }
  const change = input.changeMade;
  if (change && recordedOn(input.identifier, change.recordedAt)) {
    notes.push(
      `Resolved by a ${change.by} change recorded on the ticket: ${change.action}`
    );
    return { path };
  }
  if (classification === "Bug") {
    notes.push(
      "Resolved by triage needs evidence of a change, and this Bug has none."
    );
    return { missing: [CHANGE_GAP] };
  }
  notes.push(
    `Resolved by triage needs evidence of a change, and there is none: closed as ${classification}, Canceled.`
  );
  return { path: classification };
};

/**
 * The one gap Foreman closes itself: it is never a reason to take the
 * unproven branch or to tell the requester anything.
 */
export const REGRESSION_GAP =
  "A regression check on the blamed code. Foreman closes this one itself: run check_regression for this ticket on exactly the file, function, line range and commit in codePath (pass codePath.lines too) and pass decide_triage the same failureAt, label every commit it returns, and call decide_triage again. An unchecked result counts when the tool could not run. Do not take the unproven branch for it.";
