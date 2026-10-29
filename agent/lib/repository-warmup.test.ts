import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUN_INSTALL_CACHE_DIR,
  BUN_VERSION,
  bunInstallCommand,
  bunVersionFromPackageManager,
  findWarmRepository,
  PNPM_STORE_DIR,
  warmBunVersion,
  warmInstallCommand,
  warmInstallEnv,
  warmRepositoryPath,
} from "./repository-warmup.js";

const INVALID_REPOSITORY_PATTERN = /Invalid GitHub repository/u;
const INVALID_BUN_VERSION_PATTERN = /Invalid bun version/u;

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

  it("installs bun where every uid on the default PATH can reach it", () => {
    assert.equal(bunInstallCommand(), "npm install -g bun@1.4.4");
    assert.equal(bunInstallCommand("1.4.4"), "npm install -g bun@1.4.4");
    assert.throws(
      () => bunInstallCommand("1.4.4; x"),
      INVALID_BUN_VERSION_PATTERN
    );
  });

  it("reads only an exact bun version from packageManager", () => {
    assert.equal(bunVersionFromPackageManager("bun@1.4.4"), "1.4.4");
    assert.equal(bunVersionFromPackageManager("bun@1.4.4+sha512.abc"), "1.4.4");
    for (const value of [
      "pnpm@10.0.0",
      "bun@latest",
      "bun@1.4.4; rm -rf /",
      undefined,
      42,
      `bun@1.4.4+${"a".repeat(500)}`,
    ]) {
      assert.equal(bunVersionFromPackageManager(value), null);
    }
  });

  it("takes the warm bun from the manifest and falls back otherwise", () => {
    assert.equal(
      warmBunVersion(JSON.stringify({ packageManager: "bun@1.5.0" })),
      "1.5.0"
    );
    for (const text of [
      null,
      "{not json",
      "{}",
      JSON.stringify({ packageManager: "bun@latest" }),
      "null",
    ]) {
      assert.equal(warmBunVersion(text), BUN_VERSION);
    }
  });
});
