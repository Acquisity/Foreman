import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUN_INSTALL_CACHE_DIR,
  findWarmRepository,
  PNPM_STORE_DIR,
  warmBuildCommand,
  warmInstallCommand,
  warmInstallEnv,
  warmRepositoryPath,
  warmSnapshotRevalidationKey,
} from "./repository-warmup.js";

const INVALID_REPOSITORY_PATTERN = /Invalid GitHub repository/u;

describe("repository warm-up", () => {
  it("maps warmed slugs to fixed template paths and rejects invalid slugs", () => {
    assert.equal(
      warmRepositoryPath("Acquisity/Foreman"),
      "/workspace/.foreman/warm/Acquisity-Foreman"
    );
    assert.equal(
      warmRepositoryPath("Acquisity/Acquisity"),
      "/workspace/.foreman/warm/Acquisity-Acquisity"
    );
    assert.throws(
      () => warmRepositoryPath("not-a-repo"),
      INVALID_REPOSITORY_PATTERN
    );
  });

  it("recognizes warmed repositories case-insensitively and ignores the rest", () => {
    assert.deepEqual(findWarmRepository("acquisity/foreman"), {
      kind: "pnpm",
      slug: "Acquisity/Foreman",
    });
    assert.deepEqual(findWarmRepository("Acquisity/Acquisity"), {
      kind: "bun",
      slug: "Acquisity/Acquisity",
    });
    assert.equal(findWarmRepository("example/other"), null);
  });

  it("selects the right install command and cache env per package manager", () => {
    assert.equal(warmInstallCommand("pnpm"), "pnpm install --frozen-lockfile");
    assert.equal(warmInstallCommand("bun"), "bun install --frozen-lockfile");
    assert.deepEqual(warmInstallEnv("pnpm"), {
      npm_config_store_dir: PNPM_STORE_DIR,
      pnpm_config_store_dir: PNPM_STORE_DIR,
    });
    assert.deepEqual(warmInstallEnv("bun"), { BUN_INSTALL_CACHE_DIR });
  });

  it("selects a build command only for bun repositories", () => {
    assert.equal(warmBuildCommand("bun"), "bun run build");
    assert.equal(warmBuildCommand("pnpm"), null);
  });

  it("folds the warm-up revision and snapshot id into the revalidation key", () => {
    assert.equal(
      warmSnapshotRevalidationKey("snap_123"),
      "warm-1:snapshot-snap_123"
    );
  });

  it("falls back to a 'none' snapshot id when no snapshot exists yet", () => {
    assert.equal(
      warmSnapshotRevalidationKey(undefined),
      "warm-1:snapshot-none"
    );
  });

  it("treats an empty snapshot id the same as an unset one", () => {
    assert.equal(warmSnapshotRevalidationKey(""), "warm-1:snapshot-none");
  });
});
