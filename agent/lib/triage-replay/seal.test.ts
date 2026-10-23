import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Held-out labels stay sealed (ENG-16049): only the trusted scorer may name
 * them, and no held-out label file may sit anywhere in the repository. The
 * needles are assembled here so this file never matches itself.
 */

const HELD = ["held", "out"].join("");
const LABEL = "label";
const NEEDLES = ["-", "_"].flatMap((joiner) => [
  [HELD, `${LABEL}s`].join(joiner),
  [`${LABEL}s`, HELD].join(joiner),
]);
const SEPARATORS = /[-_]/g;
const JSON_PATH = /[\w.~/-]+\.json\b/gi;
const SCANNED = ["agent", "evals", "scripts"];
const SKIPPED = new Set([".eve", ".git", "node_modules"]);
const ALLOWED = new Set([
  "scripts/triage-score.ts",
  "agent/lib/triage-replay/score.ts",
  "agent/lib/triage-replay/leakage.ts",
]);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.has(entry.name)) {
      return [];
    }
    const path = dir === "." ? entry.name : join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const namesHeldoutLabels = (text: string) => {
  const flat = text.toLowerCase().replace(SEPARATORS, "");
  return flat.includes(HELD) && flat.includes(LABEL);
};

/** Why a file's text breaks the seal, or null when it doesn't. */
export function sealBreach(text: string): string | null {
  const lower = text.toLowerCase();
  const needle = NEEDLES.find((candidate) => lower.includes(candidate));
  if (needle) {
    return `names ${needle}`;
  }
  const path = text.match(JSON_PATH)?.find(namesHeldoutLabels);
  return path ? `names the path ${path}` : null;
}

test("only the scorer names the held-out labels", () => {
  const breaches = SCANNED.flatMap(walk)
    .filter((path) => !ALLOWED.has(path))
    .flatMap((path) => {
      const breach = sealBreach(readFileSync(path, "utf8"));
      return breach ? [`${path} ${breach}`] : [];
    });
  assert.deepEqual(breaches, []);
});

test("the seal check catches the flag, both orders and a label path", () => {
  assert.ok(sealBreach(`--${NEEDLES[0]} /tmp/x.json`));
  assert.ok(sealBreach(`read ${NEEDLES[1]}`));
  assert.ok(sealBreach(`load("evals/triage/${LABEL}s/${HELD}.json")`));
  assert.equal(sealBreach(`{"${HELD}": [], "train": []} split.json`), null);
  assert.equal(sealBreach("labels/train.json"), null);
});

test("the repository holds no held-out label file", () => {
  const found = walk(".").filter((path) =>
    namesHeldoutLabels(path.split("/").at(-1) ?? "")
  );
  assert.deepEqual(found, []);
});
