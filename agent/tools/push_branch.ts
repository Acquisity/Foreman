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
import {
  readPreparedRepository,
  remoteUrl,
  repositoryFromAuth,
} from "#lib/repository.js";
import { boundedRun } from "#lib/sandbox-deadline.js";

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
    // Only a signed GitHub webhook binds the session, and that binding is a
    // hard gate: message text must not retarget a push away from the
    // repository the webhook came from. An "explicit" authority is a default,
    // not a gate. `resolveRepository` already lets a request override it, so
    // `prepare_repository` can legitimately have prepared another repository,
    // and refusing here left those sessions unable to deliver anything at all.
    const authoritative = repositoryFromAuth(ctx.session.auth.current);
    if (
      authoritative?.source === "github-webhook" &&
      authoritative.slug.toLowerCase() !== prepared.slug.toLowerCase()
    ) {
      return {
        error: `This signed GitHub session is bound to ${authoritative.slug} and cannot push to ${prepared.slug}.`,
        success: false as const,
      };
    }
    const token = await mintInstallationToken(githubCredentials);
    try {
      await sandbox.setNetworkPolicy(brokerPolicy(token));
      const result = await boundedRun(sandbox, {
        command: `git -C '${prepared.worktree}' push ${remoteUrl(prepared.slug)} 'refs/heads/${branch}:refs/heads/${branch}'`,
      });
      if (result.exitCode !== 0) {
        return {
          error: `git push exited ${result.exitCode}: ${String(result.stderr || result.stdout).trim()}`,
          success: false as const,
        };
      }
      const head = await boundedRun(sandbox, {
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
