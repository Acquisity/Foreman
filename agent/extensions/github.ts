import githubExtension from "@github-tools/eve-extension";
import { factoryRepo } from "../lib/constants.js";
import { GITHUB_CONNECTOR } from "../lib/github/credentials.js";

/**
 * GitHub tool surface for the orchestrator, mounted as an eve extension.
 *
 * @remarks
 * - Tools appear to the model as `github__<name>`; credentials are brokered
 *   by Vercel Connect through {@link GITHUB_CONNECTOR}, resolved per call and
 *   never exposed to the model. `context` fills `owner`/`repo` from
 *   `FACTORY_REPO` so tool calls omit them.
 * - `include` is the allowlist; there is no preset. Reads, triage writes, and
 *   PR authoring are in; merge tools are deliberately absent (a person merges
 *   in the GitHub UI), and so are repo administration, gists (they 403 over
 *   Connect installation tokens), releases, and CI mutation. Omitting merge
 *   tools is the only remaining protection on writes.
 */
export default githubExtension({
  connector: GITHUB_CONNECTOR,
  context: factoryRepo,
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
});
