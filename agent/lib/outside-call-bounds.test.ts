import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "./outside-call-bounds.js";

/**
 * The regression guard behind `.github/OUTSIDE-CALLS.md`. The sweep asserts
 * that the call spellings the guard knows still carry their bound; the
 * mutation cases take one bound away from the real current source and assert
 * the guard fails on it, so the sweep is checked to fail rather than assumed
 * to. What the guard does not see is stated in `outside-call-bounds.ts`.
 */

const AGENT_ROOT = new URL("../", import.meta.url);
const REPOSITORY_ROOT = new URL("../../", import.meta.url);

/** Every authored non-test TypeScript file under the given directory. */
const sourceFiles = (dir: URL): URL[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return sourceFiles(new URL(`${entry.name}/`, dir));
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [new URL(entry.name, dir)]
      : [];
  });

const authoredSurface = () => {
  const violations: string[] = [];
  let inspected = 0;
  for (const file of sourceFiles(AGENT_ROOT)) {
    const result = inspect(fileURLToPath(file), readFileSync(file, "utf8"));
    inspected += result.inspected;
    violations.push(
      ...result.violations.map((v) => `${v.file}:${v.line} ${v.rule}`)
    );
  }
  return { inspected, violations };
};

const read = (file: string) =>
  readFileSync(new URL(file, REPOSITORY_ROOT), "utf8");

/** One bound taken out of the real current source, and the rule it must trip. */
const MUTATIONS: Array<{
  file: string;
  into: string;
  remove: string;
  rule: RegExp;
  what: string;
}> = [
  {
    file: "agent/tools/push_branch.ts",
    into: "await sandbox.run({",
    remove: "await boundedRun(sandbox, {",
    rule: /boundedRun/u,
    what: "a sandbox command run directly instead of through boundedRun",
  },
  {
    file: "agent/lib/blob.ts",
    into: "await head(key);",
    remove:
      "await head(key, { abortSignal: AbortSignal.timeout(BLOB_TIMEOUT_MS) });",
    rule: /@vercel\/blob/u,
    what: "a Blob head losing its bound while the calls around it keep one",
  },
  {
    file: "agent/lib/linear-api.ts",
    into: "",
    remove:
      "    signal: opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,\n",
    rule: /fetch call has no signal/u,
    what: "the Linear GraphQL request losing its signal",
  },
  {
    file: "agent/lib/investigation-memory/store.ts",
    into: "",
    remove:
      "    fetchOptions: { signal: AbortSignal.timeout(MEMORY_QUERY_TIMEOUT_MS) },\n",
    rule: /neon client/u,
    what: "the Neon memory client losing its request deadline",
  },
];

describe("authored outside calls stay bounded", () => {
  it("finds no unbounded call among the spellings it knows", () => {
    assert.deepEqual(authoredSurface().violations, []);
  });

  it("inspected the call sites the inventory records", () => {
    // Nine HTTP requests, four Blob operations, one Neon client. A rule that
    // stopped matching anything would pass the sweep above in silence.
    assert.ok(
      authoredSurface().inspected >= 14,
      `only ${authoredSurface().inspected} call sites were inspected`
    );
  });

  for (const mutation of MUTATIONS) {
    it(`fails on ${mutation.what}`, () => {
      const source = read(mutation.file);
      assert.ok(
        source.includes(mutation.remove),
        `${mutation.file} no longer contains the bound this case removes`
      );
      assert.deepEqual(inspect(mutation.file, source).violations, []);
      const mutated = source.replace(mutation.remove, mutation.into);
      const { violations } = inspect(mutation.file, mutated);
      assert.equal(violations.length, 1, JSON.stringify(violations));
      assert.match(violations[0]?.rule ?? "", mutation.rule);
    });
  }
});
