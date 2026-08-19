import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUN_INSTALL_CACHE_DIR,
  findWarmRepository,
  PNPM_STORE_DIR,
  warmInstallCommand,
  warmInstallEnv,
  warmRepositoryPath,
  warmRevalidationKey,
} from "./repository-warmup.js";

const INVALID_REPOSITORY_PATTERN = /Invalid GitHub repository/u;
const REVALIDATION_KEY_PATTERN = /^warm-1:foreman-lock-[0-9a-f]{64}$/u;

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
    assert.deepEqual(warmInstallEnv("pnpm"), { PNPM_STORE_DIR });
    assert.deepEqual(warmInstallEnv("bun"), { BUN_INSTALL_CACHE_DIR });
  });

  it("folds the warm-up revision and a lockfile hash into the revalidation key", () => {
    const key = warmRevalidationKey();
    assert.match(key, REVALIDATION_KEY_PATTERN);
  });
});
