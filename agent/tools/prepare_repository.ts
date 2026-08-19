import type { SessionAuthContext } from "eve/context";
import type { SandboxSession } from "eve/sandbox";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { FOREMAN_BRANCH_PREFIX } from "#lib/constants.js";
import { FALLBACK_BOT_NAME, resolveBotName } from "#lib/github/bot-name.js";
import { githubCredentials } from "#lib/github/credentials.js";
import { brokerPolicy, mintInstallationToken } from "#lib/github/git-remote.js";
import {
  REPOSITORY_MARKER,
  remoteUrl,
  resolveRepository,
  resolveRepositoryInput,
} from "#lib/repository.js";

const SAFE_IDENTITY_PATTERN = /^[A-Za-z0-9._-]{1,80}$/u;

const resolveTarget = (
  repository: string | undefined,
  auth: SessionAuthContext | null
) => {
  if (repository) {
    return resolveRepositoryInput(repository, auth);
  }
  return resolveRepository(undefined, auth);
};

const readExistingMarker = async (sandbox: SandboxSession) => {
  try {
    const existing = await sandbox.readTextFile({ path: REPOSITORY_MARKER });
    return existing === null
      ? null
      : (JSON.parse(existing) as { slug?: unknown; worktree?: unknown });
  } catch {
    return null;
  }
};

const detectWorktree = async (
  sandbox: SandboxSession
): Promise<"/workspace" | "/workspace/repo"> => {
  const root = await sandbox.run({
    command: "git -C /workspace rev-parse --show-toplevel",
  });
  return root.exitCode === 0 && String(root.stdout).trim() === "/workspace"
    ? "/workspace"
    : "/workspace/repo";
};

const cloneExplicitRepository = async (
  sandbox: SandboxSession,
  repository: string
): Promise<string | null> => {
  const occupied = await sandbox.run({ command: "test -e /workspace/repo" });
  if (occupied.exitCode === 0) {
    return "/workspace/repo already exists without a repository marker; refusing to overwrite it.";
  }
  const token = await mintInstallationToken(githubCredentials);
  await sandbox.setNetworkPolicy(brokerPolicy(token));
  try {
    const clone = await sandbox.run({
      command: `git clone --depth 50 ${remoteUrl(repository)} /workspace/repo`,
    });
    return clone.exitCode === 0
      ? null
      : `Could not clone ${repository}: ${String(clone.stderr || clone.stdout).trim()}`;
  } finally {
    await sandbox.setNetworkPolicy("allow-all");
  }
};

export default defineTool({
  description:
    "Select and prepare a GitHub repository workspace for direct work or factory mode. A signed GitHub webhook repository is authoritative. On other channels pass the one explicit owner/repo or GitHub URL from the request. Call this before editing files or delegating a repository station.",
  async execute({ repository }, ctx) {
    let target: ReturnType<typeof resolveTarget>;
    try {
      target = resolveTarget(repository, ctx.session.auth.current);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Invalid repository.",
        success: false as const,
      };
    }

    const sandbox = await ctx.getSandbox();
    const marker = await readExistingMarker(sandbox);
    if (marker) {
      const markerSlug =
        typeof marker.slug === "string" ? marker.slug.toLowerCase() : null;
      const markerWorktree =
        marker.worktree === "/workspace" ||
        marker.worktree === "/workspace/repo"
          ? marker.worktree
          : null;
      return markerSlug === target.slug.toLowerCase() && markerWorktree
        ? {
            repository: target.slug,
            reused: true,
            success: true as const,
            worktree: markerWorktree,
          }
        : {
            error: `This session already prepared ${String(marker.slug)} and cannot switch to ${target.slug}. Start a new session.`,
            success: false as const,
          };
    }

    const worktree = await detectWorktree(sandbox);
    if (worktree === "/workspace/repo") {
      const cloneError = await cloneExplicitRepository(sandbox, target.slug);
      if (cloneError) {
        return { error: cloneError, success: false as const };
      }
    }

    // The same identity the GitHub channel answers to, so commits carry the
    // deployed App's name instead of a guess.
    const identity = await resolveBotName().catch(() => FALLBACK_BOT_NAME);
    const safeIdentity = SAFE_IDENTITY_PATTERN.test(identity)
      ? identity
      : FALLBACK_BOT_NAME;
    const config = await sandbox.run({
      command: `git config --global --add safe.directory '${worktree}' && git config --global user.name '${safeIdentity}[bot]' && git config --global user.email '${safeIdentity.toLowerCase()}[bot]@users.noreply.github.com' && mkdir -p /workspace/.foreman`,
    });
    if (config.exitCode !== 0) {
      return {
        error: `Could not configure the workspace: ${String(config.stderr || config.stdout).trim()}`,
        success: false as const,
      };
    }
    await sandbox.writeTextFile({
      content: JSON.stringify(
        { ...target, branchPrefix: FOREMAN_BRANCH_PREFIX, worktree },
        null,
        2
      ),
      path: REPOSITORY_MARKER,
    });
    return {
      repository: target.slug,
      reused: worktree === "/workspace",
      success: true as const,
      worktree,
    };
  },
  inputSchema: z.object({
    repository: z
      .string()
      .min(3)
      .max(220)
      .optional()
      .describe(
        "Explicit owner/repo or GitHub URL. Omit only when the signed session already carries the repository."
      ),
  }),
});
