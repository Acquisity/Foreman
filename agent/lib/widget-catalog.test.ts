import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { WIDGET_PATHS } from "./widget-catalog.js";

test("the widget allowlist matches the widget toolkit manifest", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL(
        "../../.github/executor/widget-toolkit-manifest.json",
        import.meta.url
      ),
      "utf8"
    )
  );
  assert.deepEqual([...WIDGET_PATHS].sort(), manifest.toolkit.paths.sort());
});

test("the widget lane carries no Raindrop operation", () => {
  assert.equal(
    WIDGET_PATHS.some((path) => path.startsWith("raindrop.")),
    false
  );
});
