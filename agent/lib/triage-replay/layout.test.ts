import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { it } from "node:test";

const HERE = new URL("./", import.meta.url);
const MAX_LINES = 1000;

it("keeps every triage replay file under the repository's size boundary", () => {
  const oversized = readdirSync(HERE)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      lines: readFileSync(new URL(name, HERE), "utf8").split("\n").length,
      name,
    }))
    .filter(({ lines }) => lines > MAX_LINES)
    .map(({ lines, name }) => `${name}: ${lines}`);
  assert.deepEqual(oversized, []);
});
