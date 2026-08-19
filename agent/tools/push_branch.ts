import { defineTool } from "eve/tools";
import { z } from "zod";
import { githubCredentials } from "#lib/github/credentials.js";
import {
  brokerPolicy,
  mintInstallationToken,
  validateBranch,
} from "#lib/github/git-remote.js";
import { readPreparedRepository, remoteUrl } from "#lib/repository.js";

export default defineTool({
  description:
    "Push a committed feature branch from the prepared repository for direct work. Protected branches are refused and the validated literal GitHub URL is used.",
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
