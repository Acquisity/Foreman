import { defineTool } from "eve/tools";
import { z } from "zod";
import { githubCredentials } from "../../../lib/github/credentials.js";
import {
  brokerPolicy,
  mintInstallationToken,
  validateBranch,
} from "../../../lib/github/git-remote.js";
import { readPreparedRepository, remoteUrl } from "../../../lib/repository.js";

const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/iu;

/**
 * Fetches the branch under review and checks it out in the reviewer's
 * sandbox.
 *
 * @remarks
 * The fetch targets the factory repository's URL literally with a credential
 * brokered at the sandbox firewall (never entering the sandbox), mirroring
 * the implementer's tools. `validateBranch` bounds what can be interpolated
 * into the git command line.
 */
export default defineTool({
  description:
    "Fetch the branch under review, verify it matches the exact pushed head SHA, then hard-reset the shared workspace to that commit before independent review.",
  async execute(input, ctx) {
    const refusal = validateBranch(input.branch);
    if (refusal) {
      return { error: refusal, success: false as const };
    }
    if (!COMMIT_SHA_PATTERN.test(input.headSha)) {
      return {
        error: "headSha must be a full 40-character commit SHA.",
        success: false as const,
      };
    }
    const sandbox = await ctx.getSandbox();
    const prepared = await readPreparedRepository(sandbox);
    const url = remoteUrl(prepared.slug);
    const token = await mintInstallationToken(githubCredentials);
    try {
      await sandbox.setNetworkPolicy(brokerPolicy(token));
      const fetch = await sandbox.run({
        command: `git -C '${prepared.worktree}' fetch ${url} '${input.branch}' && test "$(git -C '${prepared.worktree}' rev-parse FETCH_HEAD)" = '${input.headSha}' && git -C '${prepared.worktree}' checkout -B '${input.branch}' '${input.headSha}' && git -C '${prepared.worktree}' reset --hard '${input.headSha}'`,
      });
      if (fetch.exitCode !== 0) {
        return {
          error: `git fetch/checkout exited ${fetch.exitCode}: ${String(
            fetch.stderr || fetch.stdout
          ).trim()}`,
          success: false as const,
        };
      }
      const head = await sandbox.run({
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
      .describe("The pushed branch to fetch and check out for review."),
    headSha: z
      .string()
      .length(40)
      .describe("The exact pushed commit SHA the reviewer must inspect."),
  }),
});
