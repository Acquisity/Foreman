import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { guideSourcePath } from "./widget-guide-source.js";

const SYMLINK = /guide source symlink/u;
const OUTSIDE = /outside docs tree/u;

test("guide sources reject symlink articles, directories, metadata and outside paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "guide-source-test-"));
  try {
    const root = join(directory, "docs");
    mkdirSync(root);
    const article = join(root, "safe.mdx");
    writeFileSync(article, "safe article");
    assert.equal(guideSourcePath(root, article), article);
    for (const name of ["linked.mdx", "meta.json", "folder"]) {
      const link = join(root, name);
      symlinkSync(name === "folder" ? directory : article, link);
      assert.throws(() => guideSourcePath(root, link), SYMLINK);
    }
    assert.throws(
      () => guideSourcePath(root, join(root, "folder", "docs", "safe.mdx")),
      SYMLINK
    );
    assert.throws(
      () => guideSourcePath(root, join(root, "..", "secret.mdx")),
      OUTSIDE
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
