import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import { stampFactoryIntent } from "./factory-lane.js";
import { repositoryFromAuth, stampRepository } from "./repository.js";
import { repositoryCapabilitiesAvailable } from "./repository-lane.js";
import { githubFactoryAuth, slackSessionAuth } from "./session-auth.js";

// prompts.ts, reached through the factory-pipeline skill, reads both connector
// variables at module load (constants.ts). Nothing is contacted. Measuring the
// compiled manifest evaluates every authored module through eve's bundled
// module map, which needs the rest of the connector environment `eve info`
// needs; `pnpm validate` runs both under the same environment.
process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??=
  "planet-scale-read-only-foreman/acquisity-foreman-planet-scale";

const { onMessage } = await import("../channels/eve.js");

const {
  CAPABILITY_LANES,
  COMPILED_MANIFEST_PATH,
  COMPILE_METADATA_PATH,
  readCompiledManifest,
  resolveLaneCapabilities,
} = await import("./capability-budget.js");

const HAS_COMPILED_MANIFEST = [
  COMPILED_MANIFEST_PATH,
  COMPILE_METADATA_PATH,
].every((path) => existsSync(new URL(`../../${path}`, import.meta.url)));

const REPOSITORY = "Acquisity/Foreman";

const SLACK_AUTH: SessionAuthContext = {
  attributes: {
    author_type: "user",
    channel_id: "C0REPOSITORYLANE",
    user_id: "U0REPOSITORYLANE",
  },
  authenticator: "slack-webhook",
  issuer: "slack:T0REPOSITORYLANE",
  principalId: "slack:T0REPOSITORYLANE:U0REPOSITORYLANE",
  principalType: "user",
};

const GITHUB_AUTH: SessionAuthContext = {
  attributes: { repository: REPOSITORY, user_login: "repository-lane" },
  authenticator: "github-webhook",
  issuer: "github:Acquisity",
  principalId: "github:1",
  principalType: "user",
  subject: "repository-lane",
};

const slack = (options: {
  readonly factoryIntent?: boolean;
  readonly intakeOnly: boolean;
  readonly repository?: string;
}) => slackSessionAuth(SLACK_AUTH, options);

/** The 31 GitHub tools, and the authored tools gated alongside them. */
const GATED_TOOLS = [
  "checkout_branch",
  "push_branch",
  "read_pipeline_run",
  "read_repository_knowledge",
  "record_pipeline_run",
  "update_repository_knowledge",
];

/**
 * Deliberately ungated. `prepare_repository` is how a lane with only a bare
 * `owner/repo` slug in its request selects a repository at all, so gating it
 * would close the door it is; `rebuild_warm_snapshot` is warm-up operations
 * and needs no selected repository.
 */
const UNGATED_TOOLS = ["prepare_repository", "rebuild_warm_snapshot"];

const GITHUB_TOOL_NAME = /^github__/u;

describe("repositoryCapabilitiesAvailable", () => {
  it("carries nothing for an ordinary Slack session", () => {
    assert.ok(!repositoryCapabilitiesAvailable(slack({ intakeOnly: false })));
    assert.ok(!repositoryCapabilitiesAvailable(slack({ intakeOnly: true })));
    assert.ok(!repositoryCapabilitiesAvailable(null));
  });

  it("carries the surface once a repository is selected", () => {
    for (const intakeOnly of [false, true]) {
      assert.ok(
        repositoryCapabilitiesAvailable(
          slack({ intakeOnly, repository: REPOSITORY })
        ),
        `intakeOnly=${intakeOnly}`
      );
    }
  });

  it("carries the surface for a signed unattended factory run", () => {
    assert.ok(
      repositoryCapabilitiesAvailable(
        githubFactoryAuth(GITHUB_AUTH, REPOSITORY, 7)
      )
    );
  });

  it("carries the surface for an explicit factory request", () => {
    assert.ok(
      repositoryCapabilitiesAvailable(
        slack({ factoryIntent: true, intakeOnly: false })
      )
    );
  });

  it("needs trust as well as intent in an intake-only channel", () => {
    // slackSessionAuth stamps trust for every admitted Slack caller, so the
    // untrusted case is built by hand: the intake rule is the one place where
    // intent alone is not enough.
    const untrusted = stampFactoryIntent({
      ...SLACK_AUTH,
      attributes: { ...SLACK_AUTH.attributes, intakeOnly: "true" },
    });
    assert.ok(!repositoryCapabilitiesAvailable(untrusted));
    assert.ok(
      repositoryCapabilitiesAvailable(
        slack({ factoryIntent: true, intakeOnly: true })
      )
    );
  });

  it("ignores a repository stamp with no recorded source", () => {
    // Only stampRepository writes the pair, and repositoryFromAuth rejects one
    // without the other, so a half-written attribute grants nothing.
    const halfStamped: SessionAuthContext = {
      ...SLACK_AUTH,
      attributes: { ...SLACK_AUTH.attributes, repository: REPOSITORY },
    };
    assert.ok(!repositoryCapabilitiesAvailable(halfStamped));
    assert.ok(
      repositoryCapabilitiesAvailable(
        stampRepository(SLACK_AUTH, REPOSITORY, "explicit")
      )
    );
  });
});

describe("eve channel repository selection", () => {
  const eveAuth = (message: string) =>
    onMessage(
      {
        eve: {
          caller: {
            attributes: {},
            authenticator: "vercel-oidc",
            issuer: "https://oidc.vercel.com/acquisity",
            principalId: "vercel:acquisity:foreman",
            principalType: "user",
          },
          request: new Request("https://foreman.test/eve/v1"),
        },
      },
      message
    ).auth;

  it("stamps one named repository, so the lane can select one at all", () => {
    const auth = eveAuth(`work on https://github.com/${REPOSITORY}`);
    assert.equal(repositoryFromAuth(auth)?.slug, REPOSITORY);
    assert.ok(repositoryCapabilitiesAvailable(auth));
  });

  it("stamps nothing from a bare slug or from two repositories", () => {
    for (const message of [
      `work on ${REPOSITORY}`,
      "look at channels/github.ts",
      `https://github.com/${REPOSITORY} and https://github.com/Acquisity/Other`,
      "nothing to see here",
    ]) {
      assert.equal(repositoryFromAuth(eveAuth(message)), null, message);
      assert.ok(!repositoryCapabilitiesAvailable(eveAuth(message)), message);
    }
  });
});

describe("runtime lane matrix", () => {
  it("admits the repository surface only where the lane needs it", {
    skip: HAS_COMPILED_MANIFEST
      ? false
      : "run pnpm validate to compile the repository manifest first",
  }, async () => {
    // Resolved through eve's own dynamic-tool dispatch against the
    // repository's compiled manifest, so this is what the model is offered,
    // not what the authored source says it should be. eve validates every
    // durable callback descriptor in that dispatch and drops a resolver's
    // whole result when one is missing, so a lane that admits its tools is
    // also a lane whose callbacks are all stamped.
    const manifest = readCompiledManifest(new URL("../../", import.meta.url));
    const resolved = await Promise.all(
      CAPABILITY_LANES.map((lane) => resolveLaneCapabilities(manifest, lane))
    );
    const byLane = new Map(
      CAPABILITY_LANES.map((lane, index) => [lane, resolved[index]])
    );
    for (const lane of ["slack", "slack-intake-only"] as const) {
      const names = byLane.get(lane)?.dynamicTools.map((tool) => tool.name);
      assert.deepEqual(names, [], `${lane} carries no gated capability`);
    }
    for (const lane of [
      "repository-interactive",
      "autonomous-factory",
    ] as const) {
      const names = new Set(
        byLane.get(lane)?.dynamicTools.map((tool) => tool.name) ?? []
      );
      for (const tool of GATED_TOOLS) {
        assert.ok(names.has(tool), `${lane} carries ${tool}`);
      }
      const github = [...names].filter((name) => GITHUB_TOOL_NAME.test(name));
      assert.equal(github.length, 31, `${lane} carries every GitHub tool`);
      assert.equal(
        names.size,
        GATED_TOOLS.length + 31,
        `${lane} carries nothing else dynamically`
      );
    }
  });

  it("leaves the door into a repository open in every lane", {
    skip: HAS_COMPILED_MANIFEST
      ? false
      : "run pnpm validate to compile the repository manifest first",
  }, () => {
    const manifest = readCompiledManifest(new URL("../../", import.meta.url));
    const staticTools = new Set(manifest.tools.map((tool) => tool.name));
    for (const tool of UNGATED_TOOLS) {
      assert.ok(staticTools.has(tool), `${tool} stays a static tool`);
    }
    for (const tool of GATED_TOOLS) {
      assert.ok(!staticTools.has(tool), `${tool} is resolved per lane`);
    }
  });
});
