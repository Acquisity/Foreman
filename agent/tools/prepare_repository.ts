import type { SessionAuthContext } from "eve/context";
import type { SandboxSession } from "eve/sandbox";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { FOREMAN_BRANCH_PREFIX } from "#lib/constants.js";
import { FALLBACK_BOT_NAME, resolveBotName } from "#lib/github/bot-name.js";
import { githubCredentials } from "#lib/github/credentials.js";
import { brokerPolicy, mintInstallationToken } from "#lib/github/git-remote.js";
import { logOpsEvent } from "#lib/ops-log.js";
import {
  parseRepository,
  REPOSITORY_MARKER,
  type RepositoryTarget,
  remoteUrl,
  resolveRepository,
  resolveRepositoryInput,
} from "#lib/repository.js";
import {
  findWarmRepository,
  type WarmRepository,
  warmInstallCommand,
  warmInstallEnv,
  warmLockfile,
  warmRepositoryPath,
} from "#lib/repository-warmup.js";
import {
  boundedRun,
  REPOSITORY_OPERATION_TIMEOUT_MS,
  TIMED_OUT_EXIT_CODE,
} from "#lib/sandbox-deadline.js";
import { isUnattended } from "#lib/trust.js";

const SAFE_IDENTITY_PATTERN = /^[A-Za-z0-9._-]{1,80}$/u;

/** The shape a revision read out of a sandbox command must have to be used. */
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/u;

/**
 * Applies the brokered GitHub credential to the sandbox firewall for the
 * duration of one credential window.
 */
export type CredentialBroker = (sandbox: SandboxSession) => Promise<void>;

export interface CheckoutOptions {
  readonly broker?: CredentialBroker;
  readonly owned?: boolean;
  readonly timeoutMs?: number;
}

const brokerGitHubToken: CredentialBroker = async (sandbox) => {
  const token = await mintInstallationToken(githubCredentials);
  await sandbox.setNetworkPolicy(brokerPolicy(token));
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
 * Where the checkout being replaced waits until its replacement is complete.
 *
 * @remarks
 * Also tool-owned, and for the same reason: a replacement that fails has to
 * put the previous checkout back, and it can only do that if the previous
 * checkout still exists somewhere no other step writes.
 */
const PREVIOUS_PATH = "/workspace/.repo-previous";

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

/** How the recovery probe reports the checkout it found still published. */
const ORIGIN_PREFIX = "origin=";

/** Recovery output proving neither the published nor set-aside checkout exists. */
const MISSING_CHECKOUT = "missing-checkout";

/**
 * Puts a checkout stranded by an interrupted switch back where its marker says
 * it is, or reports what is published there instead.
 *
 * @remarks
 * A turn cancelled between the set-aside and the restore aborts the restore
 * too, because eve binds the cancelled turn's signal into every later `run`.
 * That can strand the marker's repository at the tool-owned previous path with
 * nothing published, or, when the cancellation came after the replacement was
 * published but before the marker named it, with a different repository
 * published over it. The first is moved back here; the second cannot be
 * decided by this command alone, so it reports the published checkout's origin
 * and lets the caller weigh it against the marker.
 */
const RECOVER_PREVIOUS = `if [ -e ${PREVIOUS_PATH} ]; then if [ -e /workspace/repo ]; then echo "${ORIGIN_PREFIX}$(git config --file /workspace/repo/.git/config --get remote.origin.url)"; else mv ${PREVIOUS_PATH} /workspace/repo; fi; elif [ ! -e /workspace/repo ]; then echo "${MISSING_CHECKOUT}"; fi`;

/**
 * Puts the set-aside checkout back and reports whether the session is left on
 * a usable one.
 *
 * @remarks
 * A restore that fails takes the marker with it: the marker would otherwise
 * name a repository no checkout holds, and the next call would trust it.
 */
const restorePrevious = async (
  sandbox: SandboxSession,
  timeoutMs: number
): Promise<boolean> => {
  const restore = await boundedRun(
    sandbox,
    {
      command: `rm -rf /workspace/repo && mv ${PREVIOUS_PATH} /workspace/repo`,
    },
    timeoutMs
  ).catch(() => null);
  if (restore?.exitCode === 0) {
    return true;
  }
  await discardPath(sandbox, REPOSITORY_MARKER, timeoutMs);
  return false;
};

/** How a failed switch reports what the session is left holding. */
const rollbackMessage = (
  restored: boolean,
  previousSlug: string,
  error: string
): string =>
  restored
    ? `${error} The previously prepared ${previousSlug} is still in place.`
    : `${error} The previously prepared ${previousSlug} could not be restored, so this session has no repository prepared.`;

const resolveTarget = (
  repository: string | undefined,
  auth: SessionAuthContext | null
) => {
  if (repository) {
    return resolveRepositoryInput(repository, auth);
  }
  return resolveRepository(undefined, auth);
};

/** The repository this session already prepared, as the marker records it. */
interface PreparedMarker {
  readonly slug: string;
  readonly source: "explicit" | "github-webhook";
  readonly worktree: "/workspace" | "/workspace/repo";
}

/**
 * The prepared repository, or null when this session has none.
 *
 * @remarks
 * A marker that cannot be read, parsed, or validated counts as none, because
 * it says nothing about what is on disk. Nothing is destroyed on that reading:
 * `prepareWarmedOrClone` still refuses to publish over an occupied
 * `/workspace/repo` whose origin names another repository, so an unusable
 * marker is repaired rather than trusted or acted on.
 */
const readExistingMarker = async (
  sandbox: SandboxSession
): Promise<PreparedMarker | null> => {
  try {
    const existing = await sandbox.readTextFile({ path: REPOSITORY_MARKER });
    if (existing === null) {
      return null;
    }
    const marker = (JSON.parse(existing) ?? {}) as Partial<PreparedMarker>;
    const parsed = parseRepository(
      typeof marker.slug === "string" ? marker.slug : ""
    );
    if (
      !parsed ||
      (marker.source !== "explicit" && marker.source !== "github-webhook") ||
      (marker.worktree !== "/workspace" &&
        marker.worktree !== "/workspace/repo")
    ) {
      return null;
    }
    return {
      slug: parsed.slug,
      source: marker.source,
      worktree: marker.worktree,
    };
  } catch {
    return null;
  }
};

/**
 * Leaves the marker's own checkout published at `/workspace/repo` before
 * anything trusts the marker, or explains why it could not.
 *
 * @remarks
 * An interrupted switch can leave both tool-owned paths populated: the marker's
 * repository set aside, and the replacement it never recorded published over
 * it. Reusing that would answer for a repository the session never prepared,
 * and setting it aside would delete the only copy of the one it did, so the
 * published checkout's origin decides. One the marker names keeps its place and
 * the set-aside copy is provable debris; one it does not name is rolled back;
 * an origin that cannot be read, and a recovery that cannot run, fail closed
 * rather than guess. Every caller therefore starts from the same invariant:
 * `/workspace/repo` holds the repository the marker names and nothing waits at
 * the previous path.
 */
const reconcilePrevious = async (
  sandbox: SandboxSession,
  previous: PreparedMarker,
  timeoutMs: number
): Promise<string | null> => {
  const recover = await boundedRun(
    sandbox,
    { command: RECOVER_PREVIOUS },
    timeoutMs
  );
  if (recover.exitCode !== 0) {
    return `Could not restore the prepared checkout of ${previous.slug}: ${String(recover.stderr || recover.stdout).trim()}`;
  }
  const output = String(recover.stdout)
    .split("\n")
    .map((line) => line.trim());
  if (output.includes(MISSING_CHECKOUT)) {
    await discardPath(sandbox, REPOSITORY_MARKER, timeoutMs);
    return `The prepared checkout of ${previous.slug} is missing, so this session has no repository prepared.`;
  }
  const reported = output.find((line) => line.startsWith(ORIGIN_PREFIX));
  if (reported === undefined) {
    return null;
  }
  const origin = reported.slice(ORIGIN_PREFIX.length).toLowerCase();
  if (origin === "") {
    return `Could not tell which repository the checkout beside the set-aside ${previous.slug} holds.`;
  }
  if (origin === remoteUrl(previous.slug).toLowerCase()) {
    await discardPath(sandbox, PREVIOUS_PATH, timeoutMs);
    return null;
  }
  return (await restorePrevious(sandbox, timeoutMs))
    ? null
    : `The prepared ${previous.slug} could not be restored, so this session has no repository prepared.`;
};

/**
 * Why this session may not switch away from the repository it prepared, or
 * null when it may.
 *
 * @remarks
 * A signed GitHub session is bound to the checkout its webhook selected, on
 * either side of the switch: the marker's own source is the record of that
 * binding, and it outlives the request that is asking to move. An unattended
 * run has nobody to notice a checkout changing underneath it, so it keeps the
 * repository it started on. A checkout at `/workspace` is the channel's, not
 * this tool's, and is never replaced.
 */
const replacementRefusal = (
  previous: PreparedMarker,
  target: RepositoryTarget & { source: "explicit" | "github-webhook" },
  auth: SessionAuthContext | null,
  worktree: "/workspace" | "/workspace/repo"
): string | null => {
  if (
    previous.source === "github-webhook" ||
    target.source === "github-webhook"
  ) {
    return `This signed GitHub session is bound to the checkout of ${previous.slug} and cannot switch to ${target.slug}.`;
  }
  if (isUnattended(auth)) {
    return `This unattended session already prepared ${previous.slug} and cannot switch to ${target.slug}. Start a new run for ${target.slug}.`;
  }
  if (
    previous.worktree !== "/workspace/repo" ||
    worktree !== "/workspace/repo"
  ) {
    return `The checkout of ${previous.slug} is the session workspace itself and cannot be replaced with ${target.slug}.`;
  }
  return null;
};

export const detectWorktree = async (
  sandbox: SandboxSession,
  timeoutMs: number = REPOSITORY_OPERATION_TIMEOUT_MS
): Promise<"/workspace" | "/workspace/repo" | null> => {
  const root = await boundedRun(
    sandbox,
    { command: "git -C /workspace rev-parse --show-toplevel" },
    timeoutMs
  );
  if (root.exitCode === TIMED_OUT_EXIT_CODE) {
    return null;
  }
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
const originUrl = async (
  sandbox: SandboxSession,
  timeoutMs: number
): Promise<string | null> => {
  const origin = await boundedRun(
    sandbox,
    {
      command:
        "git config --file /workspace/repo/.git/config --get remote.origin.url",
    },
    timeoutMs
  );
  return origin.exitCode === 0
    ? String(origin.stdout).trim().toLowerCase()
    : null;
};

/**
 * Whether the repository's own lockfile differs between two revisions.
 *
 * @remarks
 * Only a proven "unchanged" answer skips the install: an unreadable revision,
 * a failed diff, and a deadline all leave the lockfile's state unknown, and
 * building against dependencies that may be stale is the worse failure. Both
 * revisions arrive as command output, so they are checked against a commit-id
 * shape before they reach a command.
 */
const lockfileChanged = async (
  sandbox: SandboxSession,
  warmed: WarmRepository,
  before: string,
  after: string,
  timeoutMs: number
): Promise<boolean> => {
  if (!(COMMIT_PATTERN.test(before) && COMMIT_PATTERN.test(after))) {
    return true;
  }
  const diff = await boundedRun(
    sandbox,
    {
      command: `git -C /workspace/repo diff --name-only ${before} ${after} -- ${warmLockfile(warmed.kind)}`,
    },
    timeoutMs
  );
  return diff.exitCode !== 0 || String(diff.stdout).trim() !== "";
};

/**
 * Refreshes `/workspace/repo` to the remote HEAD and runs the warm install
 * when the refresh moved the relevant lockfile, or unconditionally when the
 * checkout's install state is unknown. Any failure removes the checkout so a
 * retry can start over.
 */
export const refreshCheckout = async (
  sandbox: SandboxSession,
  repository: string,
  warmed: WarmRepository | null,
  installAnyway: boolean,
  {
    broker = brokerGitHubToken,
    owned = true,
    timeoutMs = REPOSITORY_OPERATION_TIMEOUT_MS,
  }: CheckoutOptions = {}
): Promise<string | null> => {
  await broker(sandbox);
  let needsInstall = installAnyway;
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
    if (before.exitCode !== 0) {
      return `Could not read the current revision for ${repository}: ${String(before.stderr || before.stdout).trim()}`;
    }
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
    if (after.exitCode !== 0) {
      return `Could not read the refreshed revision for ${repository}: ${String(after.stderr || after.stdout).trim()}`;
    }
    // HEAD moving is not itself a reason to reinstall: most revisions leave
    // the lockfile alone, and a warm install that reruns for every commit
    // spends a minute per turn to reproduce what is already on disk.
    needsInstall ||=
      warmed !== null &&
      String(before.stdout).trim() !== String(after.stdout).trim() &&
      (await lockfileChanged(
        sandbox,
        warmed,
        String(before.stdout).trim(),
        String(after.stdout).trim(),
        timeoutMs
      ));
    refreshed = true;
  } finally {
    if (owned && !refreshed) {
      await discardPath(sandbox, "/workspace/repo", timeoutMs);
    }
    await sandbox.setNetworkPolicy("allow-all");
  }

  // If the refresh left the lockfile alone, the snapshot's install already
  // matches the checkout, so there is nothing to warm.
  if (!(warmed && needsInstall)) {
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
    if (owned && !installed) {
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
  const timeoutMs = options.timeoutMs ?? REPOSITORY_OPERATION_TIMEOUT_MS;
  const occupied = await boundedRun(
    sandbox,
    { command: "test -e /workspace/repo" },
    timeoutMs
  );
  // A deadline here is not "nothing is there": publishing a checkout over an
  // occupied path would move the staged clone inside the existing one. Refuse
  // instead, and let the retry decide.
  if (occupied.exitCode === TIMED_OUT_EXIT_CODE) {
    return `Could not tell whether a checkout is already present for ${repository}: ${occupied.stderr}`;
  }
  if (occupied.exitCode === 0) {
    // A durable step retry or dev queue redelivery reruns this tool after an
    // earlier execution placed the checkout but never wrote the marker. Only a
    // readable origin naming this repository proves the checkout is adoptable;
    // anything else stays untouched. An absent origin and an unreadable
    // `.git/config` both come back as a non-zero `git config`, so neither can
    // be treated as proof of debris, and an unfinished clone or move cannot
    // land here anyway: `/workspace/repo` only ever appears as a rename of a
    // finished checkout from `STAGING_PATH`.
    return (await originUrl(sandbox, timeoutMs)) ===
      remoteUrl(repository).toLowerCase()
      ? refreshCheckout(sandbox, repository, warmed, true, {
          ...options,
          owned: false,
        })
      : "/workspace/repo already exists without a repository marker; refusing to overwrite it.";
  }

  // Derive the path from the matched config's canonical slug, not the caller's
  // casing: `findWarmRepository` matches case-insensitively, so a lowercase
  // "acquisity/foreman" would otherwise compute a path that never exists and
  // silently fall back to a cold clone.
  const path = warmed ? warmRepositoryPath(warmed.slug) : null;
  const checkout = path
    ? await boundedRun(sandbox, { command: `test -d ${path}` }, timeoutMs)
    : null;
  if (checkout?.exitCode === TIMED_OUT_EXIT_CODE) {
    return `Could not determine whether the warmed checkout exists for ${repository}: ${checkout.stderr}`;
  }
  if (!(warmed && checkout) || checkout.exitCode !== 0) {
    return cloneExplicitRepository(sandbox, repository, options);
  }

  // Staged like the clone, so a move interrupted partway (the warm root and
  // `/workspace/repo` are not guaranteed to be one rename apart) leaves its
  // remains at the tool-owned path instead of at `/workspace/repo`, where a
  // later turn could not tell them from a checkout it must not touch.
  const move = await boundedRun(
    sandbox,
    {
      command: `rm -rf ${STAGING_PATH} && mv ${path} ${STAGING_PATH} && mv ${STAGING_PATH} /workspace/repo`,
    },
    timeoutMs
  );
  if (move.exitCode !== 0) {
    await discardPath(sandbox, STAGING_PATH, timeoutMs);
    return `Could not move the warmed checkout for ${repository}: ${String(move.stderr || move.stdout).trim()}`;
  }
  // From here `/workspace/repo` is populated, so any failure must roll it
  // back or a retry in this session wedges on "already exists".
  return refreshCheckout(sandbox, repository, warmed, false, options);
};

/**
 * Swaps `/workspace/repo` for a different repository, keeping the checkout it
 * replaces until the new one is complete.
 *
 * @remarks
 * The old checkout is moved aside rather than deleted, so a clone that fails,
 * times out, or is refused can put it back and leave the session exactly where
 * it was: same checkout, same marker, still usable. Only a restore that itself
 * fails leaves the session with no checkout, and it says so, because the
 * caller then has to clear the marker instead of pointing at a path that no
 * longer holds the repository it names.
 */
const replaceCheckout = async (
  sandbox: SandboxSession,
  repository: string,
  options: CheckoutOptions
): Promise<{ error: string; restored: boolean } | null> => {
  const timeoutMs = options.timeoutMs ?? REPOSITORY_OPERATION_TIMEOUT_MS;
  const setAside = await boundedRun(
    sandbox,
    {
      command: `rm -rf ${PREVIOUS_PATH} && mv /workspace/repo ${PREVIOUS_PATH}`,
    },
    timeoutMs
  );
  if (setAside.exitCode !== 0) {
    // Nothing moved, so the previous checkout is still where it was.
    return {
      error: `Could not set the current checkout aside before switching to ${repository}: ${String(setAside.stderr || setAside.stdout).trim()}`,
      restored: true,
    };
  }
  let prepareError: string | null;
  try {
    prepareError = await prepareWarmedOrClone(sandbox, repository, options);
  } catch (error) {
    // A cancelled turn or a dead sandbox throws straight through this call, and
    // the previous checkout is only ever recoverable while something puts it
    // back. The restore is attempted even though a cancelled turn will abort it
    // too, because a sandbox error that is not a cancellation still restores.
    await restorePrevious(sandbox, timeoutMs);
    throw error;
  }
  if (prepareError) {
    return {
      error: prepareError,
      restored: await restorePrevious(sandbox, timeoutMs),
    };
  }
  // The previous checkout stays set aside: only the caller knows whether the
  // marker now names its replacement, and until it does there is still
  // something to roll back to.
  return null;
};

/** Prepares a repository for a session that has none prepared yet. */
const prepareFreshCheckout = (
  sandbox: SandboxSession,
  repository: string,
  worktree: "/workspace" | "/workspace/repo",
  options: CheckoutOptions
): Promise<string | null> =>
  worktree === "/workspace/repo"
    ? prepareWarmedOrClone(sandbox, repository, options)
    : Promise.resolve(null);

/**
 * Replaces the repository this session prepared, or explains why it may not,
 * leaving the session on a usable checkout either way.
 */
const switchPreparedRepository = async (
  sandbox: SandboxSession,
  previous: PreparedMarker,
  {
    auth,
    options,
    target,
    worktree,
  }: {
    auth: SessionAuthContext | null;
    options: CheckoutOptions;
    target: RepositoryTarget & { source: "explicit" | "github-webhook" };
    worktree: "/workspace" | "/workspace/repo";
  }
): Promise<string | null> => {
  const refusal = replacementRefusal(previous, target, auth, worktree);
  if (refusal) {
    return refusal;
  }
  const failure = await replaceCheckout(sandbox, target.slug, options);
  return failure
    ? rollbackMessage(failure.restored, previous.slug, failure.error)
    : null;
};

/**
 * Registers the worktree and the commit identity the GitHub channel answers
 * to, so commits carry the deployed App's name instead of a guess.
 */
const configureWorkspace = async (
  sandbox: SandboxSession,
  worktree: "/workspace" | "/workspace/repo"
): Promise<string | null> => {
  const identity = await resolveBotName().catch(() => FALLBACK_BOT_NAME);
  const safeIdentity = SAFE_IDENTITY_PATTERN.test(identity)
    ? identity
    : FALLBACK_BOT_NAME;
  const config = await boundedRun(sandbox, {
    command: `git config --global --add safe.directory '${worktree}' && git config --global user.name '${safeIdentity}[bot]' && git config --global user.email '${safeIdentity.toLowerCase()}[bot]@users.noreply.github.com' && mkdir -p /workspace/.foreman`,
  });
  return config.exitCode === 0
    ? null
    : `Could not configure the workspace: ${String(config.stderr || config.stdout).trim()}`;
};

/**
 * Configures the workspace and records the prepared repository, putting the
 * checkout the switch replaced back if either step fails or throws.
 *
 * @remarks
 * A completed switch still has its previous checkout set aside, because the
 * marker names it until the write here succeeds. Both steps run inside the
 * rollback: a cancelled turn or a dead sandbox throws straight through the
 * config too, and without that the marker would be left naming a repository
 * `/workspace/repo` no longer holds.
 */
const recordPreparedRepository = async (
  sandbox: SandboxSession,
  {
    previous,
    target,
    timeoutMs,
    worktree,
  }: {
    previous: PreparedMarker | null;
    target: RepositoryTarget & { source: "explicit" | "github-webhook" };
    timeoutMs: number;
    worktree: "/workspace" | "/workspace/repo";
  }
): Promise<string | null> => {
  const abandon = async (error: string) =>
    previous
      ? rollbackMessage(
          await restorePrevious(sandbox, timeoutMs),
          previous.slug,
          error
        )
      : error;
  let configError: string | null;
  try {
    configError = await configureWorkspace(sandbox, worktree);
  } catch (error) {
    return abandon(
      `Could not configure the workspace: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (configError) {
    return abandon(configError);
  }
  try {
    await sandbox.writeTextFile({
      content: JSON.stringify(
        { ...target, branchPrefix: FOREMAN_BRANCH_PREFIX, worktree },
        null,
        2
      ),
      path: REPOSITORY_MARKER,
    });
  } catch (error) {
    return abandon(
      `Could not record the prepared ${target.slug}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return null;
};

/**
 * Returns the refusal to the model and leaves exactly one bounded warning
 * behind.
 *
 * @remarks
 * A repository this session may not prepare is an operator-visible event, not
 * a silent no-op, and `logOpsEvent` keeps the line one bounded JSON record
 * that cannot break the turn. This is the only place a refusal is logged, so
 * a refusal that travelled through a rollback still leaves one line, and the
 * message is the same text the model reads.
 */
const refuse = (code: string, error: string) => {
  logOpsEvent(
    "prepare_repository.refused",
    { code, message: error },
    console.warn
  );
  return { error, success: false as const };
};

/** The part of eve's tool context preparing a repository reads. */
interface PrepareContext {
  getSandbox: () => Promise<SandboxSession>;
  session: { auth: { current: SessionAuthContext | null } };
}

/**
 * Prepares the requested repository, replacing the one this session already
 * prepared when it is allowed to switch.
 *
 * @remarks
 * The checkout options are a parameter so a test can drive a switch without a
 * real clone or a brokered token; the tool below is this function with nothing
 * added.
 */
export const prepareRepositoryWorkspace = async (
  repository: string | undefined,
  ctx: PrepareContext,
  options: CheckoutOptions = {}
) => {
  let target: ReturnType<typeof resolveTarget>;
  try {
    target = resolveTarget(repository, ctx.session.auth.current);
  } catch (error) {
    return refuse(
      "invalid_repository",
      error instanceof Error ? error.message : "Invalid repository."
    );
  }

  const sandbox = await ctx.getSandbox();
  const timeoutMs = options.timeoutMs ?? REPOSITORY_OPERATION_TIMEOUT_MS;
  const previous = await readExistingMarker(sandbox);
  // Reusing the marker and setting its checkout aside both trust it, so an
  // interrupted switch is settled before either one reads /workspace/repo.
  if (previous?.worktree === "/workspace/repo") {
    const unreconciled = await reconcilePrevious(sandbox, previous, timeoutMs);
    if (unreconciled) {
      return refuse("unreconciled_switch", unreconciled);
    }
  }
  const from = previous
    ? { repository: previous.slug, source: previous.source }
    : null;
  const current = { repository: target.slug, source: target.source };
  if (previous && previous.slug.toLowerCase() === target.slug.toLowerCase()) {
    return {
      current,
      previous: from,
      replaced: false,
      repository: target.slug,
      reused: true,
      success: true as const,
      worktree: previous.worktree,
    };
  }

  const worktree = await detectWorktree(sandbox);
  if (worktree === null) {
    return refuse(
      "worktree_unknown",
      "Could not determine whether /workspace is a repository before the deadline."
    );
  }
  const prepareError = previous
    ? await switchPreparedRepository(sandbox, previous, {
        auth: ctx.session.auth.current,
        options,
        target,
        worktree,
      })
    : await prepareFreshCheckout(sandbox, target.slug, worktree, options);
  if (prepareError) {
    return refuse("checkout_unavailable", prepareError);
  }

  const recordError = await recordPreparedRepository(sandbox, {
    previous,
    target,
    timeoutMs,
    worktree,
  });
  if (recordError) {
    return refuse("marker_unwritable", recordError);
  }
  if (previous) {
    await discardPath(sandbox, PREVIOUS_PATH, timeoutMs);
  }
  return {
    current,
    previous: from,
    replaced: previous !== null,
    repository: target.slug,
    reused: worktree === "/workspace",
    success: true as const,
    worktree,
  };
};

export default defineTool({
  description:
    "Select and prepare a GitHub repository workspace for direct work or factory mode. A signed GitHub webhook repository is authoritative and stays bound to its checkout. On other channels pass the one explicit owner/repo or GitHub URL from the request; naming a different repository replaces the prepared one. Call this before editing files or delegating a repository station.",
  execute: ({ repository }, ctx) => prepareRepositoryWorkspace(repository, ctx),
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
