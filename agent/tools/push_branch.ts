import type { SessionAuthContext } from "eve/context";
import type { SandboxSession } from "eve/sandbox";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { deliveryPolicy } from "#lib/github/approval.js";
import { githubCredentials } from "#lib/github/credentials.js";
import {
  brokerPolicy,
  mintInstallationToken,
  validateBranch,
} from "#lib/github/git-remote.js";
import { logOpsEvent } from "#lib/ops-log.js";
import {
  readPreparedRepository,
  remoteUrl,
  repositoryFromAuth,
} from "#lib/repository.js";
import { boundedRun } from "#lib/sandbox-deadline.js";

/**
 * Returns the refusal to the model and leaves exactly one bounded warning
 * behind.
 *
 * @remarks
 * A refused push is an operator-visible event, not a silent no-op, and
 * `logOpsEvent` keeps the line one bounded JSON record that cannot break the
 * turn. Branch names are model input, so nothing beyond the refusal reason
 * reaches the log.
 */
const refuse = (code: string, error: string) => {
  logOpsEvent("push_branch.refused", { code, message: error }, console.warn);
  return { error, success: false as const };
};

/**
 * Applies the brokered GitHub credential to the sandbox firewall for the
 * duration of one push.
 */
export type CredentialBroker = (sandbox: SandboxSession) => Promise<void>;

/** The part of eve's tool context a push reads. */
interface PushContext {
  getSandbox: () => Promise<SandboxSession>;
  session: { auth: { current: SessionAuthContext | null } };
}

const brokerGitHubToken: CredentialBroker = async (sandbox) => {
  const token = await mintInstallationToken(githubCredentials);
  await sandbox.setNetworkPolicy(brokerPolicy(token));
};

/**
 * Pushes a validated branch from the prepared repository.
 *
 * @remarks
 * The credential window is a parameter so a test can reach the accepted push
 * instead of stopping at the token mint, which only a Connect runtime can
 * serve. The default is the real brokered token, so the tool below is this
 * function with nothing added.
 */
export const pushPreparedBranch = async (
  branch: string,
  ctx: PushContext,
  broker: CredentialBroker = brokerGitHubToken
) => {
  const refusal = validateBranch(branch);
  if (refusal) {
    return refuse("invalid_branch", refusal);
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
    return refuse(
      "repository_binding",
      `This signed GitHub session is bound to ${authoritative.slug} and cannot push to ${prepared.slug}.`
    );
  }
  try {
    await broker(sandbox);
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
};

export default defineTool({
  approval: deliveryPolicy,
  description:
    "Push a committed feature branch from the prepared repository for direct work. Protected branches are refused and the validated literal GitHub URL is used.",
  execute: ({ branch }, ctx) => pushPreparedBranch(branch, ctx),
  inputSchema: z.object({ branch: z.string().min(1) }),
});
