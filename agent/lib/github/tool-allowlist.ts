/**
 * The GitHub extension's tool allowlist, the one list `agent/extensions/github/extension.ts`
 * passes as `include`.
 *
 * @remarks
 * It lives here rather than in the mount file because that module resolves
 * only inside eve's compiler, and the tests that check the admitted surface
 * (`agent/lib/capability-budget.test.ts`) derive their expected counts and
 * names from this list instead of a pasted number, so a legitimate allowlist
 * change moves the expectation with it. Merge tools are deliberately absent.
 */
export const GITHUB_TOOL_ALLOWLIST = [
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
] as const;
