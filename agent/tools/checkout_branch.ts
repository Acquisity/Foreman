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
      const result = await sandbox.run({
        command: `git -C '${prepared.worktree}' fetch ${remoteUrl(prepared.slug)} '${branch}' && git -C '${prepared.worktree}' checkout -B '${branch}' FETCH_HEAD`,
      });
      if (result.exitCode !== 0) {
        return {
          error: `git fetch/checkout exited ${result.exitCode}: ${String(result.stderr || result.stdout).trim()}`,
          success: false as const,
        };
      }
      const head = await sandbox.run({
        command: `git -C '${prepared.worktree}' rev-parse HEAD`,
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
