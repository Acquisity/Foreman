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
  "record_pipeline_run",
  "rebuild_warm_snapshot",
  "bash",
  "write_file",
]);

/**
 * Connections whose read-only boundary is the OAuth grant itself rather than
 * a tool allowlist: PostHog exposes one `exec` tool and requests only `:read`
 * scopes, so writes fail at the API.
 */
const READ_ONLY_BY_SCOPE = new Set(["posthog"]);

/** Connection tools that mutate provider state, by connection. */
const WRITE_CONNECTION_TOOLS: Record<string, readonly string[]> = {
  lucent: ["update_issue"],
  planetscale: ["planetscale_execute_write_query"],
  sentry: ["update_issue", "create_project", "create_team", "create_dsn"],
  supermemory: ["add_memory"],
  vercel: [
    "deploy_to_vercel",
    "change_toolbar_thread_resolve_status",
    "reply_to_toolbar_thread",
    "edit_toolbar_message",
    "add_toolbar_reaction",
  ],
};

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
    assert.deepEqual(
      list("connections/"),
      [
        "executor.ts",
        "executor-factory.ts",
        "executor-limited.ts",
        "executor-scheduled.ts",
        "executor-scheduled-internal.ts",
      ].sort()
    );
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

  it("uses separate critic toolkits and context-gated authentication", () => {
    for (const { child, root, name } of pairs) {
      assert.equal(typeof child.auth, "function", name);
      assert.equal(typeof root.auth, "function", name);
      assert.notEqual(child.url, root.url, name);
      assert.ok(String(child.url).includes("/foreman-critic-"), name);
      assert.deepEqual(child.tools, { allow: ["execute", "skills"] });
    }
  });

  it("only narrows tool allowlists and excludes every write", () => {
    for (const { child, name, root } of pairs) {
      if (READ_ONLY_BY_SCOPE.has(name)) {
        assert.equal(child.tools, root.tools, `${name}: tools unchanged`);
        continue;
      }
      const childAllow = child.tools?.allow;
      assert.ok(childAllow, `${name}: the critic must have an allowlist`);
      const rootAllow = root.tools?.allow;
      if (rootAllow) {
        for (const tool of childAllow) {
          assert.ok(
            rootAllow.includes(tool),
            `${name}: ${tool} is not on the root allowlist`
          );
        }
      }
      for (const write of WRITE_CONNECTION_TOOLS[name] ?? []) {
        assert.ok(
          !childAllow.includes(write),
          `${name}: ${write} must be excluded`
        );
      }
    }
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
