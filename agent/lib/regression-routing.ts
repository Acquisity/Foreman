import type {
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
  duplicate: boolean
): FixedRouting | undefined =>
  classification === "Bug" && !duplicate && input.regression
    ? FIXED_PATHS[input.regression.kind]
    : undefined;

/**
 * The one gap Foreman closes itself: it is never a reason to take the
 * unproven branch or to tell the requester anything.
 */
export const REGRESSION_GAP =
  "A regression check on the blamed code. Foreman closes this one itself: run check_regression for this ticket, label every commit it returns, and call decide_triage again. An unchecked result counts when the tool could not run. Do not take the unproven branch for it.";
