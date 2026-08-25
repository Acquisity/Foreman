import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../../", import.meta.url));
const ENV_ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=/u;
const DISABLED_TOOL = /disableTool\(\)/u;
const SHARES_PARENT_SANDBOX = /return parent\.sandbox|=>\s*parent\.sandbox/u;
const criticRoot = new URL("../subagents/critic/", import.meta.url);

const [{ AGENT_MODEL_SLOTS, MODELS }, { CRITIC_CRITERIA, CRITIC_VERDICTS }] =
  await Promise.all([
    import("./models.js"),
    import("../subagents/critic/agent.js"),
  ]);

const instructions = readFileSync(
  new URL("instructions.md", criticRoot),
  "utf8"
);
const skill = readFileSync(
  new URL("skills/triage-critic/SKILL.md", criticRoot),
  "utf8"
);

// Connector variables the authored modules require at evaluation time. Any
// value satisfies discovery; nothing here is ever contacted.
const stubEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const example = readFileSync(
    new URL(".env.example", `file://${appRoot}`),
    "utf8"
  );
  for (const line of example.split("\n")) {
    const name = ENV_ASSIGNMENT.exec(line)?.[1];
    if (name) {
      env[name] ??= "stub/stub";
    }
  }
  return env;
};

interface DiscoveredSubagent {
  manifest: {
    connections: { logicalPath: string }[];
    diagnosticsSummary: { errors: number };
    instructions: { definition: { content: string } }[];
    sandbox: { logicalPath: string } | null;
    skills: { name: string }[];
    tools: { logicalPath: string }[];
  };
  subagentId: string;
}

describe("critic subagent", () => {
  it("owns a model slot that live overrides can replace", () => {
    assert.equal(MODELS.critic, "openai/gpt-5.6-sol");
    assert.ok(AGENT_MODEL_SLOTS.includes("critic"));
  });

  it("declares the twelve criteria and three verdicts once", () => {
    assert.equal(CRITIC_CRITERIA.length, 12);
    assert.deepEqual(
      [...CRITIC_VERDICTS],
      ["APPROVE", "CHALLENGE", "INSUFFICIENT_EVIDENCE"]
    );
    for (const criterion of CRITIC_CRITERIA) {
      assert.ok(
        skill.includes(`\`${criterion}\``),
        `skill must define ${criterion}`
      );
    }
  });

  it("owns its sandbox because it declares a skill", () => {
    // eve's sandbox registry refuses a child that selects parent.sandbox while
    // carrying managed workspace resources, and a skill is one. Discovery and
    // eve build both accept that combination; only the runtime graph rejects
    // it, so the rule is checked here.
    const sandbox = readFileSync(new URL("sandbox.ts", criticRoot), "utf8");
    assert.doesNotMatch(sandbox, SHARES_PARENT_SANDBOX);
    assert.ok(sandbox.includes('from "../../sandbox.js"'));
  });

  it("keeps the whole procedure in the child-local skill and loads it first", () => {
    assert.ok(
      !existsSync(new URL("../skills/triage-critic/", import.meta.url))
    );
    assert.ok(instructions.includes("Load the `triage-critic` skill before"));
    assert.ok(instructions.includes("If the skill fails to load"));
    assert.ok(skill.includes("There is no attempt 3"));
    assert.ok(skill.includes("`checkout_commit`"));
  });

  it("disables every write-capable default tool", () => {
    const tools = readdirSync(new URL("tools/", criticRoot)).sort();
    for (const name of [
      "ask_question.ts",
      "bash.ts",
      "todo.ts",
      "web_fetch.ts",
      "web_search.ts",
      "write_file.ts",
    ]) {
      assert.ok(tools.includes(name), `${name} must be authored`);
      assert.match(
        readFileSync(new URL(`tools/${name}`, criticRoot), "utf8"),
        DISABLED_TOOL,
        `${name} must be disabled`
      );
    }
  });

  it("is discovered by eve with its own skill and sandbox", () => {
    // Real discovery, not a source-string check: PR #53 shipped a child whose
    // skill eve could not find because the test only looked at filenames.
    const info = JSON.parse(
      execFileSync("npx", ["eve", "info", "--json"], {
        cwd: appRoot,
        encoding: "utf8",
        env: stubEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      })
    ) as {
      artifacts: { discoveryManifest: string };
      subagents: string[];
    };
    assert.ok(info.subagents.includes("critic"));

    const manifest = JSON.parse(
      readFileSync(info.artifacts.discoveryManifest, "utf8")
    ) as { subagents: DiscoveredSubagent[] };
    const critic = manifest.subagents.find(
      (entry) => entry.subagentId === "critic"
    );
    assert.ok(critic, "critic must appear in the discovery manifest");
    assert.equal(critic.manifest.diagnosticsSummary.errors, 0);
    assert.deepEqual(
      critic.manifest.skills.map((entry) => entry.name),
      ["triage-critic"]
    );
    assert.equal(critic.manifest.sandbox?.logicalPath, "sandbox.ts");
    assert.ok(
      critic.manifest.instructions.some((entry) =>
        entry.definition.content.startsWith("# Critic")
      )
    );
    assert.deepEqual(
      critic.manifest.connections.map((c) => c.logicalPath).sort(),
      readdirSync(new URL("connections/", criticRoot))
        .map((name) => `connections/${name}`)
        .sort()
    );
    assert.deepEqual(
      critic.manifest.tools.map((tool) => tool.logicalPath).sort(),
      readdirSync(new URL("tools/", criticRoot))
        .map((name) => `tools/${name}`)
        .sort()
    );
  });
});
