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
import {
  findWarmRepository,
  warmInstallCommand,
  warmInstallEnv,
  warmRepositoryPath,
} from "#lib/repository-warmup.js";

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

/**
 * Prepares a warmed repository by moving its pre-warmed checkout into
 * `/workspace/repo`, refreshing it to the remote HEAD, and running a warm
 * install. Falls back to a cold clone for any repository that was not
 * pre-warmed (or whose warmed checkout is missing).
 */
const prepareWarmedOrClone = async (
  sandbox: SandboxSession,
  repository: string
): Promise<string | null> => {
  const warmed = findWarmRepository(repository);
  // Derive the path from the matched config's canonical slug, not the caller's
  // casing: `findWarmRepository` matches case-insensitively, so a lowercase
  // "acquisity/foreman" would otherwise compute a path that never exists and
  // silently fall back to a cold clone.
  const path = warmed ? warmRepositoryPath(warmed.slug) : null;
  const checkout = path
    ? await sandbox.run({ command: `test -d ${path}` })
    : null;
  if (!(warmed && checkout) || checkout.exitCode !== 0) {
    return cloneExplicitRepository(sandbox, repository);
  }

  const occupied = await sandbox.run({ command: "test -e /workspace/repo" });
  if (occupied.exitCode === 0) {
    return "/workspace/repo already exists without a repository marker; refusing to overwrite it.";
  }

  const token = await mintInstallationToken(githubCredentials);
  await sandbox.setNetworkPolicy(brokerPolicy(token));
  let moved = true;
  try {
    const move = await sandbox.run({ command: `mv ${path} /workspace/repo` });
    if (move.exitCode !== 0) {
      return `Could not move the warmed checkout for ${repository}: ${String(move.stderr || move.stdout).trim()}`;
    }

    // From here `/workspace/repo` is populated, so any failure must roll it
    // back or a retry in this session wedges on "already exists".
    // The moved checkout is owned by the builder uid, not the session user, so
    // git would abort with "detected dubious ownership" unless it is trusted
    // first. The `safe.directory` for `/workspace` configured in `onSession`
    // does not cover the nested repo (safe.directory is not recursive), and the
    // later `safe.directory '${worktree}'` config runs after this step, so
    // register `/workspace/repo` before any git command.
    const trust = await sandbox.run({
      command: "git config --global --add safe.directory /workspace/repo",
    });
    if (trust.exitCode !== 0) {
      await sandbox.run({ command: "rm -rf /workspace/repo" });
      return `Could not trust the warmed checkout for ${repository}: ${String(trust.stderr || trust.stdout).trim()}`;
    }
    const before = await sandbox.run({
      command: "git -C /workspace/repo rev-parse HEAD",
    });
    const refresh = await sandbox.run({
      command: `git -C /workspace/repo fetch ${remoteUrl(repository)} && git -C /workspace/repo reset --hard FETCH_HEAD`,
    });
    if (refresh.exitCode !== 0) {
      await sandbox.run({ command: "rm -rf /workspace/repo" });
      return `Could not refresh ${repository}: ${String(refresh.stderr || refresh.stdout).trim()}`;
    }
    const after = await sandbox.run({
      command: "git -C /workspace/repo rev-parse HEAD",
    });
    moved = String(before.stdout).trim() !== String(after.stdout).trim();
  } finally {
    await sandbox.setNetworkPolicy("allow-all");
  }

  // If the refresh did not move HEAD, the snapshot is already at the remote
  // HEAD and its install is current, so there is nothing to warm.
  if (!moved) {
    return null;
  }

  // Install after the brokered token window closes, so lifecycle scripts never
  // run with the GitHub credential injected.
  const install = await sandbox.run({
    command: warmInstallCommand(warmed.kind),
    env: warmInstallEnv(warmed.kind),
    workingDirectory: "/workspace/repo",
  });
  if (install.exitCode !== 0) {
    await sandbox.run({ command: "rm -rf /workspace/repo" });
    return `Could not install dependencies for ${repository}: ${String(install.stderr || install.stdout).trim()}`;
  }
  return null;
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
      const prepareError = await prepareWarmedOrClone(sandbox, target.slug);
      if (prepareError) {
        return { error: prepareError, success: false as const };
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
