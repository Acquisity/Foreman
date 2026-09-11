/**
 * Every write tool the `github` extension mounts, namespaced as the model
 * sees them.
 *
 * @remarks
 * Read-only evals assert `notCalledTool` over this whole list rather than
 * naming the one tool a bad run might reach for, so a new write tool added to
 * the extension is automatically forbidden in every read-only eval until
 * someone allows it deliberately. Keep in sync with the `include` list in
 * `agent/extensions/github/extension.ts`.
 */
export const GITHUB_WRITE_TOOLS = [
  "github__addAssignees",
  "github__addIssueComment",
  "github__addLabels",
  "github__addPullRequestComment",
  "github__closeIssue",
  "github__createIssue",
  "github__createPullRequest",
  "github__removeAssignees",
  "github__removeLabel",
  "github__requestReviewers",
  "github__updateIssue",
  "github__updatePullRequest",
] as const;

/**
 * Root-mounted write tools (not part of the `github` extension).
 *
 * @remarks
 * Read-only evals assert `notCalledTool` over this list alongside
 * {@link GITHUB_WRITE_TOOLS}, so a read-only turn that reaches for the shared
 * repository knowledge fails. Read-only knowledge and investigation-memory
 * search tools are deliberately absent.
 */
export const ROOT_WRITE_TOOLS = [
  "correct_investigation_case",
  "push_branch",
  "record_investigation_case",
  "set_agent_models",
  "update_repository_knowledge",
] as const;

/**
 * Every write tool the model can reach, extension and root alike.
 */
export const WRITE_TOOLS = [
  ...GITHUB_WRITE_TOOLS,
  ...ROOT_WRITE_TOOLS,
] as const;
