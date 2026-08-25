import { defineTool } from "eve/tools";
import { z } from "zod";
import { githubCredentials } from "../../../lib/github/credentials.js";
import {
  brokerPolicy,
  mintInstallationToken,
} from "../../../lib/github/git-remote.js";
import { readPreparedRepository, remoteUrl } from "../../../lib/repository.js";

const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/iu;

/**
 * Pin the critic's own checkout to the exact commit the investigation read.
 *
 * @remarks
 * `prepare_repository` leaves the checkout at the remote HEAD. The critic
 * must judge code claims at the commit the investigation document names, so
 * this fetches that commit through the same brokered credential the root
 * tools use (the token is injected at the sandbox firewall and never enters
 * the sandbox) and detaches HEAD onto it. Read-only: nothing here can push.
 * The SHA is validated before it reaches the command line.
 */
export default defineTool({
  description:
    "After prepare_repository, fetch the exact 40-character commit the investigation document names and check it out detached, so code claims are verified at the commit that was read rather than today's HEAD. Returns the commit now at HEAD.",
  async execute({ commit }, ctx) {
    if (!COMMIT_SHA_PATTERN.test(commit)) {
      return {
        error: "commit must be a full 40-character commit SHA.",
        success: false as const,
      };
    }
    const sha = commit.toLowerCase();
    const sandbox = await ctx.getSandbox();
    const prepared = await readPreparedRepository(sandbox);
    const token = await mintInstallationToken(githubCredentials);
    await sandbox.setNetworkPolicy(brokerPolicy(token));
    try {
      const result = await sandbox.run({
        command: `git -C '${prepared.worktree}' fetch --depth 1 ${remoteUrl(prepared.slug)} '${sha}' && git -C '${prepared.worktree}' checkout --detach '${sha}'`,
      });
      if (result.exitCode !== 0) {
        return {
          error: `git fetch/checkout exited ${result.exitCode}: ${String(result.stderr || result.stdout).trim()}`,
          success: false as const,
        };
      }
    } finally {
      await sandbox.setNetworkPolicy("allow-all");
    }
    const head = await sandbox.run({
      command: `git -C '${prepared.worktree}' rev-parse HEAD`,
    });
    return {
      commit: String(head.stdout).trim(),
      success: true as const,
      worktree: prepared.worktree,
    };
  },
  inputSchema: z.object({
    commit: z
      .string()
      .length(40)
      .describe("The commit the Triage investigation document says it read."),
  }),
});
