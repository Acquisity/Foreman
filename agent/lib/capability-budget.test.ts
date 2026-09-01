import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { defineTool } from "eve/tools";
import { z } from "zod";

// prompts.ts, reached through the factory-pipeline skill, reads both connector
// variables at module load (constants.ts). Nothing is contacted. Measuring a
// dynamic tool evaluates every authored module through eve's bundled module
// map, which needs the rest of the connector environment `eve info` needs;
// `pnpm validate` runs both under the same environment.
process.env.LINEAR_CONNECTOR = "linear/foreman-agent";
process.env.PLANETSCALE_MCP_CONNECTOR =
  "planet-scale-read-only-foreman/acquisity-foreman-planet-scale";

const {
  admitDynamicTools,
  CAPABILITY_LANES,
  capabilitySource,
  COMPILED_MANIFEST_PATH,
  COMPILE_METADATA_PATH,
  formatCapabilityBudget,
  laneAuth,
  measureCapabilityBudget,
  measureLane,
  parseCapabilityManifest,
  readCompiledManifest,
  resolveLaneCapabilities,
  subagentDelegationSchemaChars,
} = await import("./capability-budget.js");

const HAS_COMPILED_MANIFEST = [
  COMPILED_MANIFEST_PATH,
  COMPILE_METADATA_PATH,
].every((path) => existsSync(new URL(`../../${path}`, import.meta.url)));

const {
  AUTONOMOUS_PRINCIPAL,
  canUseInvestigationMemory,
  intakeIssueNumber,
  isAutonomous,
  isIntakeOnly,
  isTrusted,
  isUnattended,
} = await import("./trust.js");
const { repositoryFromAuth } = await import("./repository.js");

const SECOND_PIPELINE = /second-pipeline/u;
const UNRESOLVED_TOOL = /crm__crm/u;
const NOTHING_ADMITTED = /eve admitted none of the tools 'crm'/u;
const GITHUB_TOOL_NAME = /^github__/u;
const SLACK_PRINCIPAL = /^slack:/u;

// The repository root, so a fixture's dynamic tool resolves through the same
// bundled module map the repository's own manifest does.
const APP_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const MANIFEST_HEADER = {
  appRoot: APP_ROOT,
  kind: "eve-agent-compiled-manifest",
  version: 41,
} as const;

// A hand-built manifest with one capability of each kind from each source, so
// every counted character is known by inspection.
const FIXTURE = parseCapabilityManifest({
  ...MANIFEST_HEADER,
  dynamicSkills: [
    {
      eventNames: ["turn.started"],
      slug: "factory-pipeline",
      sourceId: "skills/factory-pipeline.ts",
    },
  ],
  dynamicTools: [
    {
      eventNames: ["step.started"],
      extensionNamespace: "github",
      logicalPath:
        "../node_modules/@github-tools/eve-extension/dist/extension/tools/github.mjs",
      slug: "github__github",
      sourceId: "ext:github:tools/github.mjs",
      sourceKind: "module",
    },
  ],
  skills: [
    {
      description: "de",
      markdown: "body",
      name: "aa",
      sourceId: "skills/aa/SKILL.md",
    },
  ],
  subagents: [{ description: "ddd", name: "s", sourceId: "subagents/s" }],
  tools: [
    {
      description: "abc",
      // JSON.stringify gives {"type":"object"}, 17 characters.
      inputSchema: { type: "object" },
      name: "t",
      sourceId: "tools/t.ts",
    },
    { description: "z", name: "b", sourceId: "ext:browser:tools/b.mjs" },
  ],
});

// One resolved set with known sizes, so the row arithmetic below is readable.
const RESOLVED = {
  dynamicSkills: [
    {
      description: "dd",
      markdown: "mmm",
      slug: "factory-pipeline",
      source: "skills/",
    },
  ],
  // name 8 + description 2 + schema 3 characters.
  dynamicTools: [
    {
      description: "gh",
      name: "github__x",
      schemaChars: 3,
      source: "ext:github",
    },
  ],
  subagentSchemaChars: 7,
};

const NO_DYNAMIC = {
  dynamicSkills: [],
  dynamicTools: [],
  subagentSchemaChars: 0,
};

describe("capability source grouping", () => {
  it("groups by extension namespace or authored directory", () => {
    assert.equal(capabilitySource("tools/checkout_branch.ts"), "tools/");
    assert.equal(capabilitySource("skills/aa/SKILL.md"), "skills/");
    assert.equal(capabilitySource("subagents/analyst"), "subagents/");
    assert.equal(
      capabilitySource("ext:browser:tools/click.mjs"),
      "ext:browser"
    );
    assert.equal(capabilitySource("ext:github:tools/github.mjs"), "ext:github");
  });
});

describe("manifest provenance", () => {
  it("rejects an artifact of another kind or revision", () => {
    assert.throws(() =>
      parseCapabilityManifest({ ...MANIFEST_HEADER, kind: "something-else" })
    );
    assert.throws(() =>
      parseCapabilityManifest({ ...MANIFEST_HEADER, version: 40 })
    );
    assert.throws(() => parseCapabilityManifest({ tools: [] }));
  });
});

describe("lane measurement", () => {
  it("counts names, descriptions, schemas, and bodies by source", () => {
    const budget = measureLane(FIXTURE, "slack", RESOLVED);
    assert.deepEqual(budget.rows, [
      {
        bodyChars: 0,
        descriptionChars: 1,
        entries: 1,
        kind: "tool",
        nameChars: 1,
        schemaChars: 0,
        source: "ext:browser",
      },
      {
        bodyChars: 0,
        descriptionChars: 2,
        entries: 1,
        kind: "tool",
        nameChars: 9,
        schemaChars: 3,
        source: "ext:github",
      },
      {
        bodyChars: 0,
        descriptionChars: 3,
        entries: 1,
        kind: "tool",
        nameChars: 1,
        schemaChars: 17,
        source: "tools/",
      },
      {
        bodyChars: 7,
        descriptionChars: 4,
        entries: 2,
        kind: "skill",
        nameChars: 18,
        schemaChars: 0,
        source: "skills/",
      },
      {
        bodyChars: 0,
        descriptionChars: 3,
        entries: 1,
        kind: "subagent",
        nameChars: 1,
        // The delegation schema eve lowers onto every subagent tool.
        schemaChars: 7,
        source: "subagents/",
      },
    ]);
    assert.equal(budget.catalogChars, 49 + 14 + 7);
    assert.equal(budget.bodyChars, 7);
  });

  it("drops the dynamic skill row for a lane that resolves none", () => {
    const budget = measureLane(FIXTURE, "autonomous-factory", {
      ...RESOLVED,
      dynamicSkills: [],
    });
    assert.ok(
      budget.rows.some((row) => row.source === "skills/" && row.entries === 1)
    );
    assert.equal(budget.catalogChars, 49 + 14 + 7 - 16 - 2);
    assert.equal(budget.bodyChars, 4);
  });

  it("sums entries from one source instead of listing them", () => {
    const manifest = parseCapabilityManifest({
      ...MANIFEST_HEADER,
      tools: [
        { description: "ab", name: "one", sourceId: "tools/one.ts" },
        { description: "c", name: "two", sourceId: "tools/two.ts" },
      ],
    });
    assert.deepEqual(measureLane(manifest, "slack", NO_DYNAMIC).rows, [
      {
        bodyChars: 0,
        descriptionChars: 3,
        entries: 2,
        kind: "tool",
        nameChars: 6,
        schemaChars: 0,
        source: "tools/",
      },
    ]);
  });
});

describe("dynamic capability resolution", () => {
  it("resolves each compiled dynamic skill through its own source", async () => {
    const resolved = await resolveLaneCapabilities(FIXTURE, "slack");
    assert.equal(resolved.dynamicSkills.length, 1);
    assert.equal(resolved.dynamicSkills[0]?.slug, "factory-pipeline");
    assert.equal(resolved.dynamicSkills[0]?.source, "skills/");
    assert.ok((resolved.dynamicSkills[0]?.markdown.length ?? 0) > 0);
  });

  it("refuses a second dynamic skill rather than repeating the first", async () => {
    const manifest = parseCapabilityManifest({
      ...MANIFEST_HEADER,
      dynamicSkills: [
        {
          eventNames: ["turn.started"],
          slug: "factory-pipeline",
          sourceId: "skills/factory-pipeline.ts",
        },
        {
          eventNames: ["turn.started"],
          slug: "second-pipeline",
          sourceId: "skills/second-pipeline.ts",
        },
      ],
    });
    await assert.rejects(
      resolveLaneCapabilities(manifest, "slack"),
      SECOND_PIPELINE
    );
  });

  it("refuses a dynamic tool source it cannot resolve", async () => {
    const manifest = parseCapabilityManifest({
      ...MANIFEST_HEADER,
      dynamicTools: [
        {
          eventNames: ["step.started"],
          extensionNamespace: "crm",
          logicalPath: "../node_modules/crm/tools/crm.mjs",
          slug: "crm__crm",
          sourceId: "ext:crm:tools/crm.mjs",
          sourceKind: "module",
        },
      ],
    });
    await assert.rejects(
      resolveLaneCapabilities(manifest, "slack"),
      UNRESOLVED_TOOL
    );
  });

  it("refuses to count a dynamic tool map eve would drop", async () => {
    // eve stamps a durable descriptor on a callback only when it bundles the
    // authored module, so every callback in this test process is bare, the
    // way a policy handed to the GitHub extension's `overrides` from anywhere
    // but durable-callbacks.ts is in a deployment. eve's own dispatch rejects
    // the entry, drops the resolver's whole result, and the measurement must
    // fail rather than count the tool as model-visible.
    const resolver = {
      eventNames: ["step.started"],
      events: {
        "step.started": () => ({
          lookup: defineTool({
            description: "Look a record up.",
            execute: () => null,
            inputSchema: z.object({ id: z.string() }),
          }),
        }),
      },
      extensionNamespace: "crm",
      logicalPath: "../node_modules/crm/tools/crm.mjs",
      slug: "crm",
      sourceId: "ext:crm:tools/crm.mjs",
      sourceKind: "module" as const,
    };
    await assert.rejects(
      admitDynamicTools(resolver, "slack", "ext:crm"),
      NOTHING_ADMITTED
    );
  });

  it("resolves the GitHub extension's model-visible tools", async () => {
    const resolved = await resolveLaneCapabilities(FIXTURE, "slack");
    assert.equal(resolved.dynamicTools.length, 31);
    for (const tool of resolved.dynamicTools) {
      assert.equal(tool.source, "ext:github");
      assert.match(tool.name, GITHUB_TOOL_NAME);
      assert.ok(tool.description.length > 0, `${tool.name} has a description`);
      assert.ok(tool.schemaChars > 0, `${tool.name} has an input schema`);
    }
  });

  it("does not reuse dynamic tools across application roots", async () => {
    await resolveLaneCapabilities(FIXTURE, "slack");
    const otherApp = parseCapabilityManifest({
      ...FIXTURE,
      appRoot: fileURLToPath(
        new URL("../../missing-capability-budget-app", import.meta.url)
      ),
    });
    await assert.rejects(resolveLaneCapabilities(otherApp, "slack"));
  });

  it("reads the subagent delegation schema from eve", async () => {
    const chars = await subagentDelegationSchemaChars(false);
    assert.ok(chars > 0);
    // The persistent-session form adds the agentId continuation field.
    assert.ok((await subagentDelegationSchemaChars(true)) > chars);
  });

  it("resolves the factory skill for every lane except the factory run", async () => {
    const resolved = await Promise.all(
      CAPABILITY_LANES.map((lane) => resolveLaneCapabilities(FIXTURE, lane))
    );
    for (const [index, lane] of CAPABILITY_LANES.entries()) {
      assert.equal(
        resolved[index]?.dynamicSkills.length,
        lane === "autonomous-factory" ? 0 : 1,
        `${lane} dynamic skills`
      );
    }
  });

  it("measures the same manifest identically every time", async () => {
    const first = await measureCapabilityBudget(FIXTURE);
    const second = await measureCapabilityBudget(FIXTURE);
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.map((budget) => budget.lane),
      [...CAPABILITY_LANES]
    );
  });
});

describe("session lanes", () => {
  // Each expectation is read from the channel that dispatches the lane:
  // `agent/channels/slack.ts` for the three Slack lanes, the factory intake
  // branch of `agent/channels/github.ts` for the fourth. Both call the same
  // helpers in `session-auth.ts` the measurement calls, so a stamp added on
  // one side without the other fails here.
  it("carries the complete Slack dispatch stamps", () => {
    for (const lane of [
      "slack",
      "slack-intake-only",
      "repository-interactive",
    ] as const) {
      const auth = laneAuth(lane);
      assert.equal(auth.authenticator, "slack-webhook", lane);
      assert.equal(auth.principalType, "user", lane);
      assert.match(auth.principalId, SLACK_PRINCIPAL, lane);
      assert.ok(isTrusted(auth), `${lane} trusted`);
      assert.ok(canUseInvestigationMemory(auth), `${lane} reads memory`);
      assert.ok(!isUnattended(auth), `${lane} attended`);
      assert.ok(!isAutonomous(auth), `${lane} not autonomous`);
      assert.equal(
        isIntakeOnly(auth),
        lane === "slack-intake-only",
        `${lane} intake-only`
      );
      assert.deepEqual(
        repositoryFromAuth(auth),
        lane === "repository-interactive"
          ? {
              owner: "Acquisity",
              repo: "Foreman",
              slug: "Acquisity/Foreman",
              source: "explicit",
            }
          : null,
        `${lane} repository`
      );
    }
  });

  it("carries the complete factory intake stamps", () => {
    const auth = laneAuth("autonomous-factory");
    assert.equal(auth.authenticator, "github-webhook");
    assert.equal(auth.principalId, AUTONOMOUS_PRINCIPAL);
    assert.equal(auth.principalType, "service");
    assert.ok(isAutonomous(auth));
    assert.ok(isUnattended(auth));
    assert.equal(intakeIssueNumber(auth), 1);
    // The GitHub channel never stamps an unattended run trusted, and never
    // stamps it for investigation memory.
    assert.ok(!isTrusted(auth));
    assert.ok(!canUseInvestigationMemory(auth));
    assert.ok(!isIntakeOnly(auth));
    assert.deepEqual(repositoryFromAuth(auth), {
      owner: "Acquisity",
      repo: "Foreman",
      slug: "Acquisity/Foreman",
      source: "github-webhook",
    });
  });
});

const LANE_HEADING = /## slack\n/u;
const TABLE_HEADING = /kind {6}source/u;
const TOTALS_LINE = /catalog 70 characters, body 7 characters/u;

describe("capability report", () => {
  it("renders every lane with its totals", () => {
    const report = formatCapabilityBudget([
      measureLane(FIXTURE, "slack", RESOLVED),
    ]);
    assert.match(report, LANE_HEADING);
    assert.match(report, TABLE_HEADING);
    assert.match(report, TOTALS_LINE);
  });

  it("measures the repository's own compiled manifest", {
    skip: HAS_COMPILED_MANIFEST
      ? false
      : "run pnpm validate to compile the repository manifest first",
  }, async () => {
    const manifest = readCompiledManifest(new URL("../../", import.meta.url));
    const budgets = await measureCapabilityBudget(manifest);
    const byLane = new Map(budgets.map((budget) => [budget.lane, budget]));
    for (const lane of CAPABILITY_LANES) {
      const budget = byLane.get(lane);
      assert.ok(budget, `${lane} measured`);
      assert.ok(budget.catalogChars > 0, `${lane} has a catalog`);
      for (const kind of ["tool", "skill", "subagent"]) {
        assert.ok(
          budget.rows.some((row) => row.kind === kind),
          `${lane} measures ${kind} characters`
        );
      }
      // The GitHub surface is resolved, not reported as unknown, and every
      // subagent carries its framework-lowered delegation schema.
      const github = budget.rows.find(
        (row) => row.kind === "tool" && row.source === "ext:github"
      );
      assert.ok(github, `${lane} measures the GitHub tools`);
      assert.equal(github.entries, 31, `${lane} counts every GitHub tool`);
      assert.ok(github.schemaChars > 0, `${lane} counts GitHub schemas`);
      for (const row of budget.rows.filter(
        (entry) => entry.kind === "subagent"
      )) {
        assert.ok(row.schemaChars > 0, `${lane} counts subagent schemas`);
      }
    }
    const slack = byLane.get("slack");
    const factory = byLane.get("autonomous-factory");
    assert.ok(slack && factory);
    // The one catalog difference the authored configuration makes today.
    assert.ok(slack.catalogChars > factory.catalogChars);
  });
});
