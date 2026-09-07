import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { linearSpec } from "../agent/lib/linear-spec.js";

await Promise.all(
  (["query", "mutation"] as const).map(async (kind) => {
    const mode = kind === "query" ? "read" : "write";
    const file = new URL(
      `../.github/executor/specs/linear-${mode}.json`,
      import.meta.url
    );
    const expected = linearSpec(kind);
    if (process.argv.includes("--check")) {
      assert.deepEqual(
        JSON.parse(await readFile(file, "utf8")),
        expected,
        `Linear ${mode} spec drifted; run pnpm executor:specs and update Executor before deploying.`
      );
    } else {
      await writeFile(file, `${JSON.stringify(expected, null, 2)}\n`);
    }
  })
);
