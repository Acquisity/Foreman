import { parseRepository } from "./repository.js";

/**
 * Shared, world-writable cache roots so the snapshot builder uid and the
 * session user (runtime install) hit the same package store instead of each
 * paying a cold install from HOME.
 */
export const PNPM_STORE_DIR = "/workspace/.cache/pnpm-store";
export const BUN_INSTALL_CACHE_DIR = "/workspace/.cache/bun";

/**
 * Where warmed checkouts live in the template snapshot, under `/workspace/.foreman`
 * alongside the repository marker.
 */
export const WARM_ROOT = "/workspace/.foreman/warm";

export type WarmKind = "pnpm" | "bun";

export interface WarmRepository {
  readonly kind: WarmKind;
  readonly slug: string;
}

/**
 * Repositories pre-warmed into the template snapshot, dependencies only.
 *
 * @remarks
 * Neither is pre-built. Foreman never needed one (stations run `pnpm
 * validate`, never `pnpm run build`), and Acquisity's build validates a long
 * list of required API keys, which a sandbox that secrets never enter cannot
 * satisfy. Stations build on demand against the warm install.
 */
export const WARM_REPOSITORIES: readonly WarmRepository[] = [
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

// pnpm reads its store dir from `pnpm_config_store_dir` (v11+) or
// `npm_config_store_dir` (v10 and earlier); there is no packageManager pin, so
// set both to avoid depending on whichever pnpm the eve image ships. bun reads
// `BUN_INSTALL_CACHE_DIR` directly.
export const warmInstallEnv = (kind: WarmKind): Record<string, string> =>
  kind === "pnpm"
    ? {
        npm_config_store_dir: PNPM_STORE_DIR,
        pnpm_config_store_dir: PNPM_STORE_DIR,
      }
    : { BUN_INSTALL_CACHE_DIR };

export const warmInstallCommand = (kind: WarmKind): string =>
  kind === "pnpm"
    ? "pnpm install --frozen-lockfile"
    : "bun install --frozen-lockfile";

/**
 * The lockfile whose contents decide whether a warm install is still current.
 *
 * @remarks
 * It is the file the matching `--frozen-lockfile` install reads, so a revision
 * that leaves it untouched cannot change what that install would produce.
 * Manifest edits that do not reach the lockfile are exactly the case a frozen
 * install refuses to act on anyway.
 */
export const warmLockfile = (kind: WarmKind): string =>
  kind === "pnpm" ? "pnpm-lock.yaml" : "bun.lock";

/**
 * The bun the snapshot installs when the warmed Acquisity/Acquisity checkout's
 * `packageManager` cannot be read.
 *
 * @remarks
 * The snapshot normally installs the bun that checkout pins, so the warm
 * install reads `bun.lock` the way its own build machines do. The runtime
 * install in `prepare_repository` uses whatever bun the snapshot carries, so a
 * bun bump in Acquisity needs `rebuild_warm_snapshot`.
 */
export const BUN_VERSION = "1.4.4";

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/u;
const BUN_PACKAGE_MANAGER_PATTERN = /^bun@(\d+\.\d+\.\d+)(?:\+[\w.-]+)?$/u;
const MAX_PACKAGE_MANAGER_LENGTH = 200;

/**
 * The exact bun version a `packageManager` field pins (`bun@x.y.z`, with an
 * optional `+hash` suffix), or null for anything else.
 */
export const bunVersionFromPackageManager = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > MAX_PACKAGE_MANAGER_LENGTH) {
    return null;
  }
  return BUN_PACKAGE_MANAGER_PATTERN.exec(value)?.[1] ?? null;
};

/**
 * The bun to install for a warmed checkout's `package.json` text, falling back
 * to `BUN_VERSION` when it is missing, unparseable, or pins no exact bun.
 */
export const warmBunVersion = (packageJson: string | null): string => {
  if (packageJson === null) {
    return BUN_VERSION;
  }
  try {
    const parsed: unknown = JSON.parse(packageJson);
    const packageManager =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { packageManager?: unknown }).packageManager
        : undefined;
    return bunVersionFromPackageManager(packageManager) ?? BUN_VERSION;
  } catch {
    return BUN_VERSION;
  }
};

/**
 * Installs bun into the snapshot at a path every uid shares.
 *
 * @remarks
 * The eve sandbox image ships node, npm, and pnpm but not bun, so a bun
 * repository cannot install without this. `npm install -g` lands the binary in
 * `/usr/local/bin`, which is on the default PATH for the session user as well
 * as the snapshot builder, so the runtime install in `prepare_repository` finds
 * it too. The official installer would put it under the builder's HOME, where
 * the session user could not reach it.
 */
export const bunInstallCommand = (version = BUN_VERSION): string => {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`Invalid bun version '${version}'.`);
  }
  return `npm install -g bun@${version}`;
};
