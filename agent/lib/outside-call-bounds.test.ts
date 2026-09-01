import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type CallClass,
  type Inspection,
  inspect,
  mask,
} from "./outside-call-bounds.js";

/**
 * The regression guard behind `.github/OUTSIDE-CALLS.md`. The sweep asserts
 * that no authored call leaves the process unbounded; the mutation cases
 * assert the sweep actually fails when a bound is taken away, one call at a
 * time.
 */

const AGENT_ROOT = new URL("../", import.meta.url);

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

const authoredSurface = (): Inspection => {
  const seen: Record<CallClass, number> = {
    blob: 0,
    fetch: 0,
    neon: 0,
    sandboxRun: 0,
  };
  const violations: Inspection["violations"] = [];
  for (const file of sourceFiles(AGENT_ROOT)) {
    const result = inspect(fileURLToPath(file), readFileSync(file, "utf8"));
    violations.push(...result.violations);
    for (const key of Object.keys(seen) as CallClass[]) {
      seen[key] += result.seen[key];
    }
  }
  return { seen, violations };
};

/** A real call site with one bound taken away, and the rule it has to trip. */
const MUTATIONS: Array<{
  file: string;
  rule: RegExp;
  source: string;
  what: string;
}> = [
  {
    file: "agent/tools/push_branch.ts",
    rule: /boundedRun/u,
    source: `const push = async (sandbox: SandboxSession) =>
      await sandbox.run({ command: "git push origin HEAD" });`,
    what: "a sandbox command run directly instead of through boundedRun",
  },
  {
    file: "agent/tools/prepare_repository.ts",
    rule: /boundedRun/u,
    source: `const probe = async (session: SandboxSession) =>
      await session.run({ command: "ls /workspace" });`,
    what: "a sandbox command on a receiver that is not named sandbox",
  },
  {
    file: "agent/lib/blob.ts",
    rule: /Blob operation head/u,
    source: `import { del, head } from "@vercel/blob";
      export const check = async (key: string) => {
        await head(key);
        await del(key, { abortSignal: AbortSignal.timeout(20_000) });
      };`,
    what: "one Blob call losing its bound while the next call keeps one",
  },
  {
    file: "agent/lib/blob.ts",
    rule: /Blob operation put/u,
    source: `import { put } from "@vercel/blob";
      export const save = async (key: string, body: string) =>
        await put(key, body, { access: "public" });`,
    what: "a Blob write with options but no abortSignal",
  },
  {
    file: "agent/lib/linear-api.ts",
    rule: /fetch call has no signal/u,
    source: `export const call = async (url: string) =>
      await fetch(url, { method: "POST" });`,
    what: "an HTTP request with no signal",
  },
  {
    file: "agent/lib/planetscale.ts",
    rule: /fetch call has no signal/u,
    source: `export const call = async (url: string, fetchImpl = fetch) => {
      const first = await fetchImpl(url, {
        method: "POST",
        signal: AbortSignal.timeout(50_000),
      });
      const second = await fetchImpl(url, { method: "POST" });
      return [first, second];
    };`,
    what: "the second of two requests losing its signal",
  },
  {
    file: "agent/lib/investigation-memory/store.ts",
    rule: /Neon client/u,
    source: `import { neon } from "@neondatabase/serverless";
      export const db = () => neon("postgres://example", { fullResults: false });`,
    what: "a Neon client built with no request deadline",
  },
  {
    file: "agent/lib/investigation-memory/store.ts",
    rule: /Neon client/u,
    source: `import { neon } from "@neondatabase/serverless";
      export const db = () =>
        neon("postgres://example", { fetchOptions: { keepalive: true } });`,
    what: "a Neon client whose fetchOptions carry no signal",
  },
];

describe("authored outside calls stay bounded", () => {
  it("bounds every outside call across the authored agent surface", () => {
    const { violations } = authoredSurface();
    assert.deepEqual(
      violations.map(
        (violation) => `${violation.file}:${violation.line} ${violation.rule}`
      ),
      []
    );
  });

  it("inspected every call class the inventory records", () => {
    const { seen } = authoredSurface();
    assert.equal(seen.sandboxRun, 1, "boundedRun is the only sandbox run call");
    assert.ok(
      seen.fetch >= 9,
      `expected the inventoried HTTP calls, saw ${seen.fetch}`
    );
    assert.ok(
      seen.blob >= 4,
      `expected the four Blob operations, saw ${seen.blob}`
    );
    assert.ok(
      seen.neon >= 1,
      `expected the Neon memory client, saw ${seen.neon}`
    );
  });

  for (const mutation of MUTATIONS) {
    it(`fails on ${mutation.what}`, () => {
      const { violations } = inspect(mutation.file, mutation.source);
      assert.equal(violations.length, 1, JSON.stringify(violations));
      assert.match(violations[0]?.rule ?? "", mutation.rule);
    });
  }

  it("passes the same call sites once their bound is restored", () => {
    const restored = inspect(
      "agent/lib/blob.ts",
      `import { head } from "@vercel/blob";
       export const check = async (key: string) =>
         await head(key, { abortSignal: AbortSignal.timeout(20_000) });`
    );
    assert.deepEqual(restored.violations, []);
    assert.equal(restored.seen.blob, 1);
  });

  it("reads structure, not text, around comments and strings", () => {
    const tricky = inspect(
      "agent/lib/example.ts",
      `const brace = /[{(]/u;
       // await head(key) in a comment is not a call
       const note = "await sandbox.run({ command: 'x' })";
       export const search = async (url: string) =>
         await fetch(url, { headers: { "x": "}" }, signal: AbortSignal.timeout(5) });`
    );
    assert.deepEqual(tricky.violations, []);
    assert.equal(tricky.seen.fetch, 1);
    assert.equal(tricky.seen.sandboxRun, 0);
  });

  it("blanks comments and strings while keeping every offset", () => {
    const text = `const a = "b(c"; // d(e\nconst f = g();`;
    const masked = mask(text);
    assert.equal(masked.length, text.length);
    assert.equal(masked.split("\n").length, text.split("\n").length);
    assert.ok(!masked.includes("b(c"));
    assert.ok(masked.includes("g()"));
  });
});
