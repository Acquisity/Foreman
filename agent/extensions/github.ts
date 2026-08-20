import githubExtension from "@github-tools/eve-extension";
import { pullRequestReadinessPolicy } from "../lib/github/approval.js";
import { GITHUB_CONNECTOR } from "../lib/github/credentials.js";

/**
 * GitHub tool surface for the orchestrator, mounted as an eve extension.
 *
 * @remarks
 * - Tools appear to the model as `github__<name>`; credentials are brokered
 *   by Vercel Connect through {@link GITHUB_CONNECTOR}, resolved per call and
 *   never exposed to the model. Every call supplies `owner` and `repo`
 *   explicitly from the signed webhook context or selected workspace.
 * - `include` is the allowlist; there is no preset. Reads, triage writes, and
 *   PR authoring are in; merge tools are deliberately absent (a person merges
 *   in the GitHub UI), and so are repo administration, gists (they 403 over
 *   Connect installation tokens), releases, and CI mutation.
 * - `requireApproval: false` is load-bearing, not decorative. Left unset, the
 *   extension attaches `always()` to every write tool in the allowlist, so
 *   opening a pull request or leaving a comment raises an approval card on
 *   every call. Slack cannot answer one, which parks the session for good.
 *   The allowlist is one bound on these writes, not the only one: every tool
 *   resolves its own credential, `owner` and `repo` are always explicit, and
 *   `pullRequestReadinessPolicy` denies the one transition that presents work
 *   as reviewable.
 * - `overrides` gates `updatePullRequest` on that policy. It denies rather than
 *   parks, so the run keeps moving on every surface. Note that moving
 *   `requireApproval` to the per-tool object form would silently re-gate every
 *   tool absent from the object with `always()`, so the override is the safe
 *   place for a per-tool rule.
 */
export default githubExtension({
  connector: GITHUB_CONNECTOR,
  include: [
    "getRepository",
    "getRepositoryTree",
    "getFileContent",
    "searchCode",
    "listBranches",
    "listCommits",
    "getCommit",
    "compareCommits",
    "searchIssues",
    "listIssues",
    "getIssueContext",
    "listIssueComments",
    "createIssue",
    "updateIssue",
    "closeIssue",
    "addIssueComment",
    "listLabels",
    "addLabels",
    "removeLabel",
    "addAssignees",
    "removeAssignees",
    "listPullRequests",
    "getPullRequestContext",
    "listPullRequestFiles",
    "listPullRequestReviews",
    "createPullRequest",
    "updatePullRequest",
    "addPullRequestComment",
    "requestReviewers",
    "listCheckRuns",
    "getCiFailureContext",
  ],
  overrides: { updatePullRequest: { approval: pullRequestReadinessPolicy } },
  requireApproval: false,
});
