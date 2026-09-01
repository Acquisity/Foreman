import assert from "node:assert/strict";
import { describe, it } from "node:test";

// prompts.ts, reached through the factory-pipeline skill, reads both connector
// variables at module load (constants.ts). Nothing is contacted.
process.env.LINEAR_CONNECTOR = "linear/foreman-agent";
process.env.PLANETSCALE_MCP_CONNECTOR =
  "planet-scale-read-only-foreman/acquisity-foreman-planet-scale";

const {
  CAPABILITY_LANES,
  capabilitySource,
  formatCapabilityBudget,
  laneAuth,
  measureCapabilityBudget,
  measureLane,
  parseCapabilityManifest,
  readCompiledManifest,
  resolveFactoryPipelineSkill,
} = await import("./capability-budget.js");

const { isAutonomous, isIntakeOnly, isTrusted } = await import("./trust.js");
const { repositoryFromAuth } = await import("./repository.js");

// A hand-built manifest with one capability of each kind from each source, so
// every counted character is known by inspection.
const FIXTURE = parseCapabilityManifest({
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
      slug: "github__github",
      sourceId: "ext:github:tools/github.mjs",
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

const FACTORY_SKILL = { description: "dd", markdown: "mmm" };

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

describe("lane measurement", () => {
  it("counts names, descriptions, schemas, and bodies by source", () => {
    const budget = measureLane(FIXTURE, "slack", FACTORY_SKILL);
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
        descriptionChars: 3,
        entries: 1,
        kind: "tool",
        nameChars: 1,
        schemaChars: 17,
        source: "tools/",
      },
      {
        bodyChars: 3,
        descriptionChars: 2,
        entries: 1,
        kind: "skill",
        nameChars: 16,
        schemaChars: 0,
        source: "dynamic:factory-pipeline",
      },
      {
        bodyChars: 4,
        descriptionChars: 2,
        entries: 1,
        kind: "skill",
        nameChars: 2,
        schemaChars: 0,
        source: "skills/",
      },
      {
        bodyChars: 0,
        descriptionChars: 3,
        entries: 1,
        kind: "subagent",
        nameChars: 1,
        schemaChars: 0,
        source: "subagents/",
      },
    ]);
    assert.equal(budget.catalogChars, 49);
    assert.equal(budget.bodyChars, 7);
  });

  it("drops the dynamic skill row for a lane that resolves none", () => {
    const budget = measureLane(FIXTURE, "autonomous-factory", null);
    assert.ok(
      !budget.rows.some((row) => row.source === "dynamic:factory-pipeline")
    );
    assert.equal(budget.catalogChars, 49 - 16 - 2);
    assert.equal(budget.bodyChars, 4);
  });

  it("sums entries from one source instead of listing them", () => {
    const manifest = parseCapabilityManifest({
      tools: [
        { description: "ab", name: "one", sourceId: "tools/one.ts" },
        { description: "c", name: "two", sourceId: "tools/two.ts" },
      ],
    });
    assert.deepEqual(measureLane(manifest, "slack", null).rows, [
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

  it("reports a dynamic tool source as unresolved rather than guessing", () => {
    assert.deepEqual(measureLane(FIXTURE, "slack", FACTORY_SKILL).unresolved, [
      {
        events: ["step.started"],
        kind: "tool",
        slug: "github__github",
        source: "ext:github",
      },
    ]);
  });

  it("measures the same manifest identically every time", async () => {
    const [first, second] = await Promise.all([
      measureCapabilityBudget(FIXTURE),
      measureCapabilityBudget(FIXTURE),
    ]);
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.map((budget) => budget.lane),
      [...CAPABILITY_LANES]
    );
  });
});

describe("session lanes", () => {
  it("stamps each lane the way its channel does", () => {
    assert.ok(isTrusted(laneAuth("slack")));
    assert.ok(!isIntakeOnly(laneAuth("slack")));
    assert.ok(isIntakeOnly(laneAuth("slack-intake-only")));
    assert.equal(
      repositoryFromAuth(laneAuth("repository-interactive"))?.slug,
      "Acquisity/Foreman"
    );
    assert.ok(isAutonomous(laneAuth("autonomous-factory")));
  });

  it("resolves the factory skill for every lane except the factory run", async () => {
    const skills = await Promise.all(
      CAPABILITY_LANES.map((lane) => resolveFactoryPipelineSkill(lane))
    );
    for (const [index, lane] of CAPABILITY_LANES.entries()) {
      const skill = skills[index];
      if (lane === "autonomous-factory") {
        assert.equal(skill, null);
      } else {
        assert.ok(skill && skill.markdown.length > 0);
      }
    }
  });
});

const LANE_HEADING = /## slack\n/u;
const TABLE_HEADING = /kind {6}source/u;
const TOTALS_LINE = /catalog 49 characters, body 7 characters/u;
const UNRESOLVED_LINE = /unresolved tool github__github from ext:github/u;

describe("capability report", () => {
  it("renders every lane with its totals", () => {
    const report = formatCapabilityBudget([
      measureLane(FIXTURE, "slack", FACTORY_SKILL),
    ]);
    assert.match(report, LANE_HEADING);
    assert.match(report, TABLE_HEADING);
    assert.match(report, TOTALS_LINE);
    assert.match(report, UNRESOLVED_LINE);
  });

  it("measures the repository's own compiled manifest when it exists", async () => {
    const manifest = readCompiledManifest(new URL("../../", import.meta.url));
    if (!manifest) {
      // A fresh checkout has no `.eve/`; `pnpm validate` runs `eve info` after
      // the tests, so the fixture cases above carry the method on their own.
      return;
    }
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
    }
    const slack = byLane.get("slack");
    const factory = byLane.get("autonomous-factory");
    assert.ok(slack && factory);
    // The one catalog difference the authored configuration makes today.
    assert.ok(slack.catalogChars > factory.catalogChars);
  });
});
