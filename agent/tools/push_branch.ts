import { defineTool } from "eve/tools";
import { z } from "zod";
import { FOREMAN_BRANCH_PREFIX } from "#lib/constants.js";
import { deliveryPolicy } from "#lib/github/approval.js";
import { githubCredentials } from "#lib/github/credentials.js";
import {
  brokerPolicy,
  mintInstallationToken,
  validateBranch,
} from "#lib/github/git-remote.js";
import { readPreparedRepository, remoteUrl } from "#lib/repository.js";

export default defineTool({
  approval: deliveryPolicy,
  description:
    "Push a committed feature branch from the prepared repository for direct work. Protected branches are refused and the validated literal GitHub URL is used.",
  async execute({ branch }, ctx) {
    const refusal = validateBranch(branch);
    if (refusal) {
      return { error: refusal, success: false as const };
    }
    if (!branch.startsWith(FOREMAN_BRANCH_PREFIX)) {
      return {
        error: `Branch must start with ${FOREMAN_BRANCH_PREFIX}.`,
        success: false as const,
      };
    }
    const sandbox = await ctx.getSandbox();
    const prepared = await readPreparedRepository(sandbox);
    const token = await mintInstallationToken(githubCredentials);
    await sandbox.setNetworkPolicy(brokerPolicy(token));
    try {
      const result = await sandbox.run({
        command: `git -C '${prepared.worktree}' push ${remoteUrl(prepared.slug)} 'refs/heads/${branch}:refs/heads/${branch}'`,
      });
      if (result.exitCode !== 0) {
        return {
          error: `git push exited ${result.exitCode}: ${String(result.stderr || result.stdout).trim()}`,
          success: false as const,
        };
      }
      const head = await sandbox.run({
        command: `git -C '${prepared.worktree}' rev-parse '${branch}'`,
      });
      if (head.exitCode !== 0) {
        return {
          error: "Could not verify the pushed commit.",
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
