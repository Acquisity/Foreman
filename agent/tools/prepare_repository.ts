import type { SessionAuthContext } from "eve/context";
import type {
  SandboxCommandResult,
  SandboxRunOptions,
  SandboxSession,
} from "eve/sandbox";
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
  type WarmRepository,
  warmInstallCommand,
  warmInstallEnv,
  warmRepositoryPath,
} from "#lib/repository-warmup.js";

const SAFE_IDENTITY_PATTERN = /^[A-Za-z0-9._-]{1,80}$/u;

/**
 * Wall-clock bound for one clone, fetch/reset, or install.
 *
 * @remarks
 * A stalled git or package-manager process holds the whole turn: eve's
 * `run` blocks until the command exits, and nothing else in the session
 * wakes up. Five minutes is above the slowest observed cold clone plus
 * install of the warmed repositories and well under the invocation
 * ceiling, so a healthy run never trips it and a wedged one always does.
 */
export const REPOSITORY_OPERATION_TIMEOUT_MS = 300_000;

// The exit code a shell reports for a command killed by `timeout`, reused
// here so the existing non-zero branches surface a deadline like any other
// command failure.
const TIMED_OUT_EXIT_CODE = 124;

/**
 * Applies the brokered GitHub credential to the sandbox firewall for the
 * duration of one credential window.
 */
export type CredentialBroker = (sandbox: SandboxSession) => Promise<void>;

export interface CheckoutOptions {
  readonly broker?: CredentialBroker;
  readonly timeoutMs?: number;
}

const brokerGitHubToken: CredentialBroker = async (sandbox) => {
  const token = await mintInstallationToken(githubCredentials);
  await sandbox.setNetworkPolicy(brokerPolicy(token));
};

/**
 * Runs one sandbox command under a deadline.
 *
 * @remarks
 * eve 0.44's sandbox `run` takes an `abortSignal` and no timeout of its own,
 * and it composes the signal with the session's, so `AbortSignal.timeout` is
 * the version-matched bound. A deadline comes back as a non-zero result so
 * every caller's existing failure branch (which already discards the partial
 * checkout) handles it; anything else, including a cancelled turn, still
 * throws.
 */
const boundedRun = async (
  sandbox: SandboxSession,
  options: SandboxRunOptions,
  timeoutMs: number
): Promise<SandboxCommandResult> => {
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    return await sandbox.run({ ...options, abortSignal: deadline });
  } catch (error) {
    if (!deadline.aborted) {
      throw error;
    }
    return {
      exitCode: TIMED_OUT_EXIT_CODE,
      stderr: `timed out after ${timeoutMs}ms`,
      stdout: "",
    };
  }
};

/**
 * Where a checkout is built before it becomes `/workspace/repo`.
 *
 * @remarks
 * Nothing but this tool writes this path, so anything found here is provably
 * an unfinished clone or move and can be cleared without inspecting it. That
 * is the whole point: `/workspace/repo` is only ever published by renaming a
 * finished checkout into place, so a `/workspace/repo` that exists is always a
 * complete checkout whose origin decides what happens to it, and a failure to
 * read that origin is never mistaken for proof of debris.
 */
const STAGING_PATH = "/workspace/.repo-staging";

/**
 * Removes a path this tool owns, best effort: a failed cleanup must never mask
 * the failure that triggered it.
 */
const discardPath = (
  sandbox: SandboxSession,
  path: string,
  timeoutMs: number
): Promise<unknown> =>
  boundedRun(sandbox, { command: `rm -rf ${path}` }, timeoutMs).catch(
    () => undefined
  );

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

export const cloneExplicitRepository = async (
  sandbox: SandboxSession,
  repository: string,
  {
    broker = brokerGitHubToken,
    timeoutMs = REPOSITORY_OPERATION_TIMEOUT_MS,
  }: CheckoutOptions = {}
): Promise<string | null> => {
  await broker(sandbox);
  let published = false;
  try {
    // A turn cancelled mid-clone aborts the cleanup in `finally` too, because
    // eve binds the cancelled turn's signal into every later `run`. Whatever it
    // left can only be at the staging path, so clearing that first unwedges the
    // retry without touching anything whose provenance is unknown.
    await discardPath(sandbox, STAGING_PATH, timeoutMs);
    const clone = await boundedRun(
      sandbox,
      {
        command: `git clone --depth 50 ${remoteUrl(repository)} ${STAGING_PATH}`,
      },
      timeoutMs
    );
    if (clone.exitCode !== 0) {
      return `Could not clone ${repository}: ${String(clone.stderr || clone.stdout).trim()}`;
    }
    const publish = await boundedRun(
      sandbox,
      { command: `mv ${STAGING_PATH} /workspace/repo` },
      timeoutMs
    );
    published = publish.exitCode === 0;
    return published
      ? null
      : `Could not clone ${repository}: ${String(publish.stderr || publish.stdout).trim()}`;
  } finally {
    // A clone that timed out, failed, or threw leaves a partial checkout at the
    // staging path, and the next attempt would refuse to clone over it.
    if (!published) {
      await discardPath(sandbox, STAGING_PATH, timeoutMs);
    }
    await sandbox.setNetworkPolicy("allow-all");
  }
};

// Reads the checkout's origin from its config file directly: repository
// discovery would refuse the builder-owned checkout as dubious ownership
// before `safe.directory` is registered.
const originUrl = async (sandbox: SandboxSession): Promise<string | null> => {
  const origin = await sandbox.run({
    command:
      "git config --file /workspace/repo/.git/config --get remote.origin.url",
  });
  return origin.exitCode === 0
    ? String(origin.stdout).trim().toLowerCase()
    : null;
};

/**
 * Refreshes `/workspace/repo` to the remote HEAD and runs the warm install
 * when HEAD moved, or unconditionally when the checkout's install state is
 * unknown. Any failure removes the checkout so a retry can start over.
 */
export const refreshCheckout = async (
  sandbox: SandboxSession,
  repository: string,
  warmed: WarmRepository | null,
  installAnyway: boolean,
  {
    broker = brokerGitHubToken,
    timeoutMs = REPOSITORY_OPERATION_TIMEOUT_MS,
  }: CheckoutOptions = {}
): Promise<string | null> => {
  await broker(sandbox);
  let moved = true;
  let refreshed = false;
  try {
    // The moved checkout is owned by the builder uid, not the session user, so
    // git would abort with "detected dubious ownership" unless it is trusted
    // first. The `safe.directory` for `/workspace` configured in `onSession`
    // does not cover the nested repo (safe.directory is not recursive), and the
    // later `safe.directory '${worktree}'` config runs after this step, so
    // register `/workspace/repo` before any git command.
    const trust = await boundedRun(
      sandbox,
      { command: "git config --global --add safe.directory /workspace/repo" },
      timeoutMs
    );
    if (trust.exitCode !== 0) {
      return `Could not trust the warmed checkout for ${repository}: ${String(trust.stderr || trust.stdout).trim()}`;
    }
    const before = await boundedRun(
      sandbox,
      { command: "git -C /workspace/repo rev-parse HEAD" },
      timeoutMs
    );
    const refresh = await boundedRun(
      sandbox,
      {
        command: `git -C /workspace/repo fetch ${remoteUrl(repository)} && git -C /workspace/repo reset --hard FETCH_HEAD`,
      },
      timeoutMs
    );
    if (refresh.exitCode !== 0) {
      return `Could not refresh ${repository}: ${String(refresh.stderr || refresh.stdout).trim()}`;
    }
    const after = await boundedRun(
      sandbox,
      { command: "git -C /workspace/repo rev-parse HEAD" },
      timeoutMs
    );
    moved = String(before.stdout).trim() !== String(after.stdout).trim();
    refreshed = true;
  } finally {
    if (!refreshed) {
      await discardPath(sandbox, "/workspace/repo", timeoutMs);
    }
    await sandbox.setNetworkPolicy("allow-all");
  }

  // If the refresh did not move HEAD, the snapshot is already at the remote
  // HEAD and its install is current, so there is nothing to warm.
  if (!(warmed && (moved || installAnyway))) {
    return null;
  }

  // Install after the brokered token window closes, so lifecycle scripts never
  // run with the GitHub credential injected.
  let installed = false;
  try {
    const install = await boundedRun(
      sandbox,
      {
        command: warmInstallCommand(warmed.kind),
        env: warmInstallEnv(warmed.kind),
        workingDirectory: "/workspace/repo",
      },
      timeoutMs
    );
    installed = install.exitCode === 0;
    return installed
      ? null
      : `Could not install dependencies for ${repository}: ${String(install.stderr || install.stdout).trim()}`;
  } finally {
    if (!installed) {
      await discardPath(sandbox, "/workspace/repo", timeoutMs);
    }
  }
};

/**
 * Prepares a warmed repository by moving its pre-warmed checkout into
 * `/workspace/repo`, refreshing it to the remote HEAD, and running a warm
 * install. Falls back to a cold clone for any repository that was not
 * pre-warmed (or whose warmed checkout is missing).
 */
export const prepareWarmedOrClone = async (
  sandbox: SandboxSession,
  repository: string,
  options: CheckoutOptions = {}
): Promise<string | null> => {
  const warmed = findWarmRepository(repository);
  const occupied = await sandbox.run({ command: "test -e /workspace/repo" });
  if (occupied.exitCode === 0) {
    // A durable step retry or dev queue redelivery reruns this tool after an
    // earlier execution placed the checkout but never wrote the marker. Only a
    // readable origin naming this repository proves the checkout is adoptable;
    // anything else stays untouched. An absent origin and an unreadable
    // `.git/config` both come back as a non-zero `git config`, so neither can
    // be treated as proof of debris, and an unfinished clone or move cannot
    // land here anyway: `/workspace/repo` only ever appears as a rename of a
    // finished checkout from `STAGING_PATH`.
    return (await originUrl(sandbox)) === remoteUrl(repository).toLowerCase()
      ? refreshCheckout(sandbox, repository, warmed, true, options)
      : "/workspace/repo already exists without a repository marker; refusing to overwrite it.";
  }

  // Derive the path from the matched config's canonical slug, not the caller's
  // casing: `findWarmRepository` matches case-insensitively, so a lowercase
  // "acquisity/foreman" would otherwise compute a path that never exists and
  // silently fall back to a cold clone.
  const path = warmed ? warmRepositoryPath(warmed.slug) : null;
  const checkout = path
    ? await sandbox.run({ command: `test -d ${path}` })
    : null;
  if (!(warmed && checkout) || checkout.exitCode !== 0) {
    return cloneExplicitRepository(sandbox, repository, options);
  }

  // Staged like the clone, so a move interrupted partway (the warm root and
  // `/workspace/repo` are not guaranteed to be one rename apart) leaves its
  // remains at the tool-owned path instead of at `/workspace/repo`, where a
  // later turn could not tell them from a checkout it must not touch.
  const move = await sandbox.run({
    command: `rm -rf ${STAGING_PATH} && mv ${path} ${STAGING_PATH} && mv ${STAGING_PATH} /workspace/repo`,
  });
  if (move.exitCode !== 0) {
    return `Could not move the warmed checkout for ${repository}: ${String(move.stderr || move.stdout).trim()}`;
  }
  // From here `/workspace/repo` is populated, so any failure must roll it
  // back or a retry in this session wedges on "already exists".
  return refreshCheckout(sandbox, repository, warmed, false, options);
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
