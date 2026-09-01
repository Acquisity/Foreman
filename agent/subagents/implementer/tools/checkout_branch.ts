import { defineTool } from "eve/tools";
import { z } from "zod";
import { githubCredentials } from "../../../lib/github/credentials.js";
import {
  brokerPolicy,
  mintInstallationToken,
  validateBranch,
} from "../../../lib/github/git-remote.js";
import { readPreparedRepository, remoteUrl } from "../../../lib/repository.js";
import { boundedRun } from "../../../lib/sandbox-deadline.js";

/**
 * Fetches an existing factory branch and checks it out in the sandbox, for
 * revision runs that continue work the reviewer sent back.
 *
 * @remarks
 * The fetch targets the factory repository's URL literally with a credential
 * brokered at the sandbox firewall (never entering the sandbox), mirroring
 * `push_branch`. `validateBranch` bounds what can be interpolated into the
 * git command line.
 */
export default defineTool({
  description:
    "Fetch an existing branch from the prepared repository by literal validated URL and check it out for a revision.",
  async execute(input, ctx) {
    const refusal = validateBranch(input.branch);
    if (refusal) {
      return { error: refusal, success: false as const };
    }
    const sandbox = await ctx.getSandbox();
    const prepared = await readPreparedRepository(sandbox);
    const url = remoteUrl(prepared.slug);
    const token = await mintInstallationToken(githubCredentials);
    await sandbox.setNetworkPolicy(brokerPolicy(token));
    try {
      const fetch = await boundedRun(sandbox, {
        command: `git -C '${prepared.worktree}' fetch ${url} '${input.branch}' && git -C '${prepared.worktree}' checkout -B '${input.branch}' FETCH_HEAD`,
      });
      if (fetch.exitCode !== 0) {
        return {
          error: `git fetch/checkout exited ${fetch.exitCode}: ${String(
            fetch.stderr || fetch.stdout
          ).trim()}`,
          success: false as const,
        };
      }
      const head = await boundedRun(sandbox, {
        command: `git -C '${prepared.worktree}' rev-parse HEAD`,
      });
      return {
        branch: input.branch,
        sha: String(head.stdout).trim(),
        success: true as const,
      };
    } finally {
      await sandbox.setNetworkPolicy("allow-all");
    }
  },
  inputSchema: z.object({
    branch: z
      .string()
      .min(1)
      .describe("The existing branch to fetch and check out."),
  }),
});
