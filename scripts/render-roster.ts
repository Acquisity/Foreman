import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { renderRoster } from "../agent/lib/owner-roster.js";

const file = new URL(
  "../agent/skills/triage-handling/references/roster.md",
  import.meta.url
);

if (process.argv.includes("--check")) {
  assert.equal(
    await readFile(file, "utf8"),
    renderRoster(),
    "roster.md drifted from agent/lib/owner-map.ts; run pnpm roster and commit the result."
  );
} else {
  await writeFile(file, renderRoster());
}
