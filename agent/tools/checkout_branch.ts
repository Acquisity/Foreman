import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { githubCredentials } from "#lib/github/credentials.js";
import {
  brokerPolicy,
  mintInstallationToken,
  validateBranch,
} from "#lib/github/git-remote.js";
import { readPreparedRepository, remoteUrl } from "#lib/repository.js";
import { repositoryCapabilitiesAvailable } from "#lib/repository-lane.js";
import { boundedRun } from "#lib/sandbox-deadline.js";

export const checkoutBranchTool = defineTool({
  description:
    "Fetch and check out an existing feature branch in the prepared repository for direct revision work. Uses the validated literal GitHub URL.",
  async execute({ branch }, ctx) {
    const refusal = validateBranch(branch);
    if (refusal) {
      return { error: refusal, success: false as const };
    }
    const sandbox = await ctx.getSandbox();
    const prepared = await readPreparedRepository(sandbox);
    const token = await mintInstallationToken(githubCredentials);
    await sandbox.setNetworkPolicy(brokerPolicy(token));
    try {
      const result = await boundedRun(sandbox, {
        command: `git -C '${prepared.worktree}' fetch ${remoteUrl(prepared.slug)} '${branch}' && git -C '${prepared.worktree}' checkout -B '${branch}' FETCH_HEAD`,
      });
      if (result.exitCode !== 0) {
        return {
          error: `git fetch/checkout exited ${result.exitCode}: ${String(result.stderr || result.stdout).trim()}`,
          success: false as const,
        };
      }
      const head = await boundedRun(sandbox, {
        command: `git -C '${prepared.worktree}' rev-parse HEAD`,
      });
      if (head.exitCode !== 0) {
        return {
          error: `git rev-parse HEAD exited ${head.exitCode}: ${String(
            head.stderr || head.stdout
          ).trim()}`,
          success: false as const,
        };
      }
      return {
        branch,
        sha: String(head.stdout).trim(),
        success: true as const,
      };
    } finally {
      await sandbox.setNetworkPolicy("allow-all");
    }
  },
  inputSchema: z.object({ branch: z.string().min(1) }),
});

/**
 * Absent from a lane with no repository selected and no factory path open to
 * it. `agent/lib/repository-lane.ts` owns the decision and the reasoning; it
 * gates the catalog only, never authorization, and the resolver re-runs each
 * turn so a later message naming a repository restores the tool. The tool
 * itself is the same object either way, so its callbacks keep the durable
 * descriptors eve stamped on the `defineTool` call above.
 */
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      repositoryCapabilitiesAvailable(ctx.session.auth.current)
        ? checkoutBranchTool
        : null,
  },
});
