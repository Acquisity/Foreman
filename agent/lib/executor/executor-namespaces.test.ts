import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EXECUTOR_DISCOVERY, EXECUTOR_NAMESPACES } from "./instructions.js";

const manifest = JSON.parse(
  readFileSync(
    new URL("../../../.github/executor/toolkit-manifest.json", import.meta.url),
    "utf8"
  )
) as { toolkit: { paths: string[] } };

test("discovery names exactly the root toolkit's app slugs", () => {
  const listed = Object.values(EXECUTOR_NAMESPACES).flat();
  assert.equal(new Set(listed).size, listed.length, "a slug is listed twice");
  const apps = new Set(
    manifest.toolkit.paths.map((path) => path.split(".")[0])
  );
  assert.deepEqual([...listed].sort(), [...apps].sort());
  for (const slug of listed) {
    assert.ok(EXECUTOR_DISCOVERY.includes(slug), slug);
  }
});
