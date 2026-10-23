import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { outsideRepositoryPath } from "./cohort-files.js";

const INSIDE = /must live outside this repository/u;
const MISSING = /ENOENT/u;

describe("a file that must live outside the repository", () => {
  const scratch = mkdtempSync(join(tmpdir(), "outside-repo-"));
  const root = join(scratch, "repo");
  const elsewhere = join(scratch, "elsewhere");
  const lookalike = join(scratch, "repo-labels");
  for (const dir of [root, join(root, "sub"), elsewhere, lookalike]) {
    mkdirSync(dir, { recursive: true });
  }
  const touch = (path: string) => {
    writeFileSync(path, "[]");
    return path;
  };

  it("refuses a repository file named like a parent step", () => {
    assert.throws(
      () =>
        outsideRepositoryPath(touch(join(root, "..gold.json")), "Labels", root),
      INSIDE
    );
    assert.throws(
      () =>
        outsideRepositoryPath(
          touch(join(root, "sub", "gold.json")),
          "Labels",
          root
        ),
      INSIDE
    );
  });

  it("refuses a link that points into the repository, and a root reached through a link", () => {
    const target = touch(join(root, "linked.json"));
    const link = join(elsewhere, "link.json");
    symlinkSync(target, link);
    assert.throws(() => outsideRepositoryPath(link, "Labels", root), INSIDE);
    const alias = join(scratch, "alias");
    symlinkSync(root, alias);
    assert.throws(() => outsideRepositoryPath(target, "Labels", alias), INSIDE);
  });

  it("accepts a file outside, including a sibling folder that shares the repository's name as a prefix", () => {
    const outside = touch(join(elsewhere, "gold.json"));
    assert.equal(
      outsideRepositoryPath(outside, "Labels", root),
      realpathSync(outside)
    );
    const sibling = touch(join(lookalike, "gold.json"));
    assert.equal(
      outsideRepositoryPath(sibling, "Labels", root),
      realpathSync(sibling)
    );
  });

  it("refuses a file that does not exist, and cleans up", () => {
    assert.throws(
      () => outsideRepositoryPath(join(elsewhere, "none.json"), "Labels", root),
      MISSING
    );
    rmSync(scratch, { force: true, recursive: true });
  });
});
