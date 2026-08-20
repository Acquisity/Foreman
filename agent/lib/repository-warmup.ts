import { parseRepository } from "./repository.js";

/**
 * Warm-up revision. Bump it whenever the warm-up mechanics change (a new
 * repository, a different install command, or a cache layout move) so eve
 * rebuilds the template snapshot instead of reusing a stale one.
 */
export const WARM_UP_REVISION = "1";

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
 * Repositories pre-warmed into the template snapshot. Foreman warms only its
 * dependency install (stations run `pnpm validate`, never `pnpm run build`);
 * Acquisity warms both install and build so `.next`/`.turbo` are ready.
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
 * The bun the snapshot installs, matching the `setup-bun` pin in
 * Acquisity/Acquisity's own CI so the warm install reads `bun.lock` the same
 * way its build machines do. Bump it when that pin moves.
 */
export const BUN_VERSION = "1.3.5";

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
export const bunInstallCommand = (): string =>
  `npm install -g bun@${BUN_VERSION}`;

/**
 * Build-time revalidation component for the warm-up. Folds in the warm-up
 * revision and the external snapshot id so a rebuilt snapshot (or the first
 * snapshot ever) rebuilds the template. When no snapshot exists yet the id is
 * `"none"` and the template cold-clones, which is the safe pre-first-snapshot
 * fallback.
 */
export const warmSnapshotRevalidationKey = (
  snapshotId: string | undefined
): string => `warm-${WARM_UP_REVISION}:snapshot-${snapshotId || "none"}`;
