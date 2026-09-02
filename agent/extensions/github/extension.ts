import githubExtension from "@github-tools/eve-extension";
import { GITHUB_CONNECTOR } from "../../lib/github/credentials.js";
import {
  durableIntakeOnlyApproval,
  durableModelOutput,
  durableReadinessApproval,
} from "../../lib/github/durable-callbacks.js";
import { GITHUB_TOOL_ALLOWLIST } from "../../lib/github/tool-allowlist.js";

/**
 * GitHub tool surface for the orchestrator, mounted as an eve extension.
 *
 * @remarks
 * - Tools appear to the model as `github__<name>`; credentials are brokered
 *   by Vercel Connect through {@link GITHUB_CONNECTOR}, resolved per call and
 *   never exposed to the model. Every call supplies `owner` and `repo`
 *   explicitly from the signed webhook context or selected workspace.
 * - `include` is the allowlist, read from `agent/lib/github/tool-allowlist.ts`;
 *   there is no preset. Reads, triage writes, and
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
 * - `overrides` gates `updatePullRequest` on that policy, and `createPullRequest`
 *   on `intakeOnlyPolicy`, because opening a pull request is delivery too and an
 *   intake-only channel files to Linear instead of shipping. Both deny rather
 *   than park, so the run keeps moving on every surface. Note that moving
 *   `requireApproval` to the per-tool object form would silently re-gate every
 *   tool absent from the object with `always()`, so the override is the safe
 *   place for a per-tool rule.
 * - Every callback in `overrides` comes from `durable-callbacks.ts`, and the
 *   five tools that ship their own `toModelOutput` are overridden for no other
 *   reason. eve 0.44 drops the whole 31-tool map when one callback lacks a
 *   durable descriptor, and only a callback authored inline in a `defineTool`
 *   call has one. Passing a policy or a projection written anywhere else here
 *   removes the GitHub surface from every session, silently.
 */
export default githubExtension({
  connector: GITHUB_CONNECTOR,
  include: [...GITHUB_TOOL_ALLOWLIST],
  overrides: {
    compareCommits: { toModelOutput: durableModelOutput },
    createPullRequest: { approval: durableIntakeOnlyApproval },
    getCommit: { toModelOutput: durableModelOutput },
    getFileContent: { toModelOutput: durableModelOutput },
    getPullRequestContext: { toModelOutput: durableModelOutput },
    listPullRequestFiles: { toModelOutput: durableModelOutput },
    updatePullRequest: { approval: durableReadinessApproval },
  },
  requireApproval: false,
});
