import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Connector variables the root modules require at evaluation time. Nothing
// here is contacted; the values only have to exist.
const ENV_ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=/u;
const TS_EXTENSION = /\.ts$/u;
for (const line of readFileSync(
  new URL("../../.env.example", import.meta.url),
  "utf8"
).split("\n")) {
  const name = ENV_ASSIGNMENT.exec(line)?.[1];
  if (name) {
    process.env[name] ??= "stub/stub";
  }
}

const criticRoot = new URL("../subagents/critic/", import.meta.url);
const list = (dir: string): string[] =>
  readdirSync(new URL(dir, criticRoot))
    .filter((name) => name.endsWith(".ts"))
    .sort();

interface Connection {
  approval?: unknown;
  auth?: {
    evict?: unknown;
    getToken?: unknown;
    principalType?: unknown;
    vercelConnect?: unknown;
  };
  tools?: { allow?: readonly string[] };
  url?: unknown;
}

const load = async (path: string): Promise<Connection> =>
  ((await import(path)) as { default: Connection }).default;

// Every child connection beside its root, loaded once for the tests below.
process.env.EXECUTOR_BASE_URL = "https://executor.acquisity.ai";

const pairs = await Promise.all(
  list("connections/").map(async (file) => {
    const name = file.replace(TS_EXTENSION, "");
    const [child, root] = await Promise.all([
      load(`../subagents/critic/connections/${name}.js`),
      load(`../connections/${name}.js`),
    ]);
    return { child, name, root };
  })
);

/** Root tools that mutate anything, by name. None may be mounted. */
const WRITE_TOOL_NAMES = new Set([
  "record_investigation_case",
  "correct_investigation_case",
  "push_branch",
  "checkout_branch",
  "update_repository_knowledge",
  "set_agent_models",
  "save_user_preferences",
  "clear_user_preferences",
  "rebuild_warm_snapshot",
  "bash",
  "write_file",
]);

// Anything that would give the child its own credential path. PR #55 was a
// full connection outage caused by auto-provisioning; the child must reuse
// the root's managedConnect / userConnect objects and nothing else.
const FORBIDDEN_SOURCE = [
  /@vercel\/connect/u,
  /\bconnect\s*\(/u,
  /process\.env/u,
  /connector\s*:/u,
  /requireEnv\s*\(/u,
  /managedConnect\s*\(/u,
  /userConnect\s*\(/u,
  /token/iu,
];

describe("critic evidence surface", () => {
  it("mounts every triage evidence connection", () => {
    assert.deepEqual(list("connections/"), ["executor.ts"]);
  });

  it("never authors a credential path of its own", () => {
    for (const dir of ["connections/", "tools/"]) {
      for (const name of list(dir)) {
        const source = readFileSync(
          new URL(`${dir}${name}`, criticRoot),
          "utf8"
        );
        // checkout_commit brokers the root GitHub credential through the
        // sandbox firewall exactly as checkout_branch does; its imports are
        // root helpers, and the word "token" names that helper's argument.
        const patterns =
          name === "checkout_commit.ts"
            ? FORBIDDEN_SOURCE.filter((pattern) => pattern.source !== "token")
            : FORBIDDEN_SOURCE;
        for (const pattern of patterns) {
          assert.doesNotMatch(
            source,
            pattern,
            `${dir}${name} matches ${pattern}`
          );
        }
      }
    }
  });

  it("shares root company authentication and its toolkit", () => {
    for (const { child, root, name } of pairs) {
      assert.equal(typeof child.auth, "function", name);
      assert.equal(typeof root.auth, "function", name);
      assert.equal(child.url, root.url, name);
      assert.ok(String(child.url).includes("/foreman?"), name);
      assert.deepEqual(child.tools, { allow: ["execute", "skills"] });
    }
  });

  it("retains read-only critic instructions with shared provider access", () => {
    const source = readFileSync(new URL("agent.ts", criticRoot), "utf8");
    assert.ok(source.includes("Read-only: never writes to Linear"));
  });

  it("mounts no write-capable tool", () => {
    for (const file of list("tools/")) {
      const name = file.replace(TS_EXTENSION, "");
      const source = readFileSync(new URL(`tools/${file}`, criticRoot), "utf8");
      if (source.includes("disableTool()")) {
        continue;
      }
      assert.ok(!WRITE_TOOL_NAMES.has(name), `${name} is a write tool`);
    }
  });
});
