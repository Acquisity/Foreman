import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SandboxSession } from "eve/sandbox";
import { githubCredentials } from "./github/credentials.js";
import { brokerPolicy, mintInstallationToken } from "./github/git-remote.js";
import { parseRepository, remoteUrl } from "./repository.js";

/**
 * Warm-up revision. Bump it whenever the warm-up mechanics change (a new
 * repository, a different install command, or a cache layout move) so eve
 * rebuilds the template snapshot instead of reusing a stale one.
 */
export const WARM_UP_REVISION = "1";

/**
 * Shared, world-writable cache roots so the builder uid (bootstrap) and the
 * session user (runtime install) hit the same package store instead of each
 * paying a cold install from HOME.
 */
export const PNPM_STORE_DIR = "/workspace/.cache/pnpm-store";
export const BUN_INSTALL_CACHE_DIR = "/workspace/.cache/bun";

/**
 * Where warmed checkouts live at template build time, outside the session
 * working tree and out of the marker directory's way.
 */
const WARM_ROOT = "/workspace/.foreman/warm";

export type WarmKind = "pnpm" | "bun";

export interface WarmRepository {
  readonly kind: WarmKind;
  readonly slug: string;
}

/**
 * Repositories pre-warmed into the template snapshot. Foreman warms only its
 * dependency install (stations run `pnpm validate`, never `pnpm run build`);
 * Acquisity warms both install and build so `.next`/`.turbo` are ready.
 *
 * Note: only Foreman's lockfile feeds the revalidation key, so Acquisity's
 * freshness is not snapshot-tracked here; its session-time `bun install` and
 * the scheduled recreation follow-up keep it current.
 */
const WARM_REPOSITORIES: readonly WarmRepository[] = [
  { kind: "pnpm", slug: "Acquisity/Foreman" },
  { kind: "bun", slug: "Acquisity/Acquisity" },
];

/**
 * The fixed template path for a warmed checkout, derived from the validated
 * slug (which `parseRepository` already restricts to path-safe characters).
 */
export const warmRepositoryPath = (slug: string): string => {
  const parsed = parseRepository(slug);
  if (!parsed) {
    throw new Error(`Invalid GitHub repository '${slug}'.`);
  }
  return `${WARM_ROOT}/${parsed.owner}-${parsed.repo}`;
};

export const findWarmRepository = (slug: string): WarmRepository | null =>
  WARM_REPOSITORIES.find(
    (repository) => repository.slug.toLowerCase() === slug.toLowerCase()
  ) ?? null;

export const warmInstallEnv = (kind: WarmKind): Record<string, string> =>
  kind === "pnpm" ? { PNPM_STORE_DIR } : { BUN_INSTALL_CACHE_DIR };

export const warmInstallCommand = (kind: WarmKind): string =>
  kind === "pnpm"
    ? "pnpm install --frozen-lockfile"
    : "bun install --frozen-lockfile";

const failure = (
  label: string,
  result: {
    exitCode: number;
    stdout: string;
    stderr: string;
  }
): string => `${label}: ${String(result.stderr || result.stdout).trim()}`;

/**
 * Clones, installs (and builds, for Bun repos) one repository into its fixed
 * warm path. The whole checkout — including `.git`, the tracked working-tree
 * files, and `node_modules` — lands in the template snapshot; `chmod` makes
 * them readable/writable by the session user, which runs as a different uid
 * than the builder, so the later `git reset --hard` and station edits succeed.
 */
const warmRepository = async (
  sandbox: SandboxSession,
  repository: WarmRepository
): Promise<void> => {
  const path = warmRepositoryPath(repository.slug);
  const clone = await sandbox.run({
    command: `git clone --depth 1 ${remoteUrl(repository.slug)} ${path}`,
  });
  if (clone.exitCode !== 0) {
    throw new Error(failure(`Could not warm ${repository.slug}`, clone));
  }

  const env = warmInstallEnv(repository.kind);
  const install = await sandbox.run({
    command: warmInstallCommand(repository.kind),
    env,
    workingDirectory: path,
  });
  if (install.exitCode !== 0) {
    throw new Error(
      failure(`Could not install dependencies for ${repository.slug}`, install)
    );
  }

  if (repository.kind === "bun") {
    const build = await sandbox.run({
      command: "bun run build",
      env,
      workingDirectory: path,
    });
    if (build.exitCode !== 0) {
      throw new Error(failure(`Could not build ${repository.slug}`, build));
    }
  }

  const chmod = await sandbox.run({
    command: `chmod -R a+rwX ${path}`,
  });
  if (chmod.exitCode !== 0) {
    throw new Error(
      failure(`Could not make ${repository.slug} world-writable`, chmod)
    );
  }
};

/**
 * Pre-warms every configured repository into the template snapshot. Runs once
 * at template build time from `agent/sandbox.ts` bootstrap. Resolves the
 * Connect-managed installation token up front and brokers it onto github.com
 * egress; if it cannot resolve at build time this throws loudly rather than
 * silently skipping the warm-up.
 */
export const warmAllRepositories = async (
  sandbox: SandboxSession
): Promise<void> => {
  const token = await mintInstallationToken(githubCredentials);
  await sandbox.setNetworkPolicy(brokerPolicy(token));
  try {
    const mkdir = await sandbox.run({
      command: `mkdir -p ${WARM_ROOT} ${PNPM_STORE_DIR} ${BUN_INSTALL_CACHE_DIR}`,
    });
    if (mkdir.exitCode !== 0) {
      throw new Error(failure("Could not create warm-up directories", mkdir));
    }
    // A failure already names its repository in the error message, so the
    // concurrent warm-up stays attributable while keeping the installs fast.
    await Promise.all(
      WARM_REPOSITORIES.map((repository) => warmRepository(sandbox, repository))
    );
    // Make the warm root writable too: the session user renames
    // `/workspace/.foreman/warm/<slug>` to `/workspace/repo`, which needs
    // write permission on the builder-owned parent (mode 755).
    const chmod = await sandbox.run({
      command: `chmod -R a+rwX ${WARM_ROOT} ${PNPM_STORE_DIR} ${BUN_INSTALL_CACHE_DIR}`,
    });
    if (chmod.exitCode !== 0) {
      throw new Error(
        failure("Could not make warm-up directories world-writable", chmod)
      );
    }
  } finally {
    await sandbox.setNetworkPolicy("allow-all");
  }
};

/**
 * Build-time revalidation component for the warm-up. Folds in the warm-up
 * revision and a hash of Foreman's own lockfile so a Foreman dependency bump
 * rebuilds the template snapshot. Acquisity freshness is covered by the
 * session-time `bun install` and the scheduled recreation follow-up.
 *
 * The lockfile is read relative to `process.cwd()` because eve evaluates the
 * revalidation key from a bundled copy of this module (so `import.meta.url`
 * points at the cache bundle, not the source tree); `eve build` runs from the
 * repository root, where `pnpm-lock.yaml` lives.
 */
export const warmRevalidationKey = (): string => {
  const lockfile = readFileSync(join(process.cwd(), "pnpm-lock.yaml"), "utf8");
  const hash = createHash("sha256").update(lockfile).digest("hex");
  return `warm-${WARM_UP_REVISION}:foreman-lock-${hash}`;
};
