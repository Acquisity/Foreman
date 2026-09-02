import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { SandboxSession } from "eve/sandbox";
import {
  evePackageUrl,
  loadCompiledDynamicToolResolvers,
  openDynamicToolTurn,
} from "./eve-dynamic-tools.js";
import { stampFactoryIntent } from "./factory-lane.js";
import { deliveryPolicy, intakeOnlyPolicy } from "./github/approval.js";
import { repositoryFromAuth, stampRepository } from "./repository.js";
import { repositoryCapabilitiesAvailable } from "./repository-lane.js";
import { selectedRepositorySlug } from "./repository-selection.js";
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

/**
 * eve's own context storage, reached by path the way `eve-dynamic-tools.ts`
 * reaches eve's dynamic-tool runtime: none of it is on eve's package exports
 * map, and a measurement that faked the scope would prove nothing about the
 * scope eve actually runs a tool and a `step.started` resolver in. The storage
 * itself lives on `globalThis`, so this shares the one the running eve uses.
 */
interface EveContextModule {
  ContextContainer: new () => unknown;
  contextStorage: { run: <T>(store: unknown, run: () => T) => T };
}

const { ContextContainer, contextStorage } = (await import(
  new URL("./dist/src/context/container.js", evePackageUrl()).href
)) as EveContextModule;

/** Runs `body` inside one fresh eve context, as eve runs one session's turn. */
const inSession = <T>(body: () => T): T =>
  contextStorage.run(new ContextContainer(), body);

/**
 * A sandbox whose `/workspace` is already the repository, so preparing it
 * clones nothing: what is under test is what a successful preparation records,
 * not how the checkout arrived.
 */
const workspaceSandbox = () =>
  ({
    readTextFile: () => Promise.resolve(null),
    run: ({ command }: { command: string }) =>
      Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: command.includes("rev-parse --show-toplevel")
          ? "/workspace"
          : "",
      }),
    setNetworkPolicy: () => Promise.resolve(),
    writeTextFile: () => Promise.resolve(),
  }) as unknown as SandboxSession;

const prepare = async (auth: SessionAuthContext, repository: string) => {
  const { prepareRepositoryWorkspace } = await import(
    "../tools/prepare_repository.js"
  );
  return await prepareRepositoryWorkspace(repository, {
    getSandbox: () => Promise.resolve(workspaceSandbox()),
    session: { auth: { current: auth } },
  });
};

const pushApproval = (current: SessionAuthContext) =>
  ({
    session: { auth: { current } },
    toolName: "push_branch",
  }) as unknown as Parameters<typeof deliveryPolicy>[0];

const createPullRequestApproval = (current: SessionAuthContext) =>
  ({
    session: { auth: { current } },
    toolName: "github__createPullRequest",
  }) as unknown as Parameters<typeof intakeOnlyPolicy>[0];

describe("a repository prepared at runtime", () => {
  it("answers the gate yes from the moment the slug is recorded", async () => {
    // The regression this pins: Slack stamps a repository only from a full
    // GitHub URL, so "open a PR in the foreman repo" arrives with nothing
    // stamped. The model reads the slug, calls the ungated prepare_repository,
    // and used to get the checkout and neither the repository tools nor the
    // GitHub surface.
    //
    // This covers the predicate only: that a successful preparation records
    // the slug and the gate reads it back in the same context. Whether a tool
    // is then resolved into what the model carries is a lifecycle question the
    // predicate cannot answer, and "the same turn a repository is prepared"
    // below is the test that answers it.
    const auth = slack({ intakeOnly: false });
    assert.ok(!repositoryCapabilitiesAvailable(auth));
    await inSession(async () => {
      assert.equal(selectedRepositorySlug(), null);
      const result = await prepare(auth, REPOSITORY);
      assert.equal(result.success, true);
      assert.equal(selectedRepositorySlug(), REPOSITORY);
      assert.ok(repositoryCapabilitiesAvailable(auth));
    });
  });

  it("widens the catalog in an intake-only channel without widening delivery", async () => {
    // The one place a wider catalog must not become a wider permission:
    // investigating a repository from an intake-only thread is the point, and
    // delivering from one is denied whatever the catalog carries.
    const auth = slack({ intakeOnly: true });
    await inSession(async () => {
      assert.equal((await prepare(auth, REPOSITORY)).success, true);
      assert.ok(repositoryCapabilitiesAvailable(auth));
      for (const status of [
        deliveryPolicy(pushApproval(auth)),
        intakeOnlyPolicy(pushApproval(auth)),
        intakeOnlyPolicy(createPullRequestApproval(auth)),
      ]) {
        assert.equal(typeof status === "object" && status.type, "denied");
      }
    });
  });

  it("leaves a signed webhook session bound to the repository it was signed for", async () => {
    const signed = stampRepository(GITHUB_AUTH, REPOSITORY, "github-webhook");
    await inSession(async () => {
      // A signed session cannot switch, so the state never disagrees with the
      // signature; even if it did, authority is read from the auth alone.
      const refused = await prepare(signed, "Acquisity/Other");
      assert.equal(refused.success, false);
      assert.equal(selectedRepositorySlug(), null);
      assert.equal(repositoryFromAuth(signed)?.slug, REPOSITORY);
      assert.equal(repositoryFromAuth(signed)?.source, "github-webhook");
      assert.ok(repositoryCapabilitiesAvailable(signed));
    });
  });

  it("answers from the auth alone when the state is unreadable", () => {
    // Outside a context every state call throws, which is exactly what a
    // resolver eve dispatches without one would hit. A resolver that threw
    // would lose its whole result and take all 31 GitHub tools with it, so
    // both accessors swallow and the gate falls back to what auth says.
    assert.equal(selectedRepositorySlug(), null);
    assert.ok(!repositoryCapabilitiesAvailable(slack({ intakeOnly: false })));
    assert.ok(
      repositoryCapabilitiesAvailable(
        stampRepository(SLACK_AUTH, REPOSITORY, "explicit")
      )
    );
  });

  it("records nothing outside a session, and never throws trying", async () => {
    const { rememberSelectedRepository } = await import(
      "./repository-selection.js"
    );
    assert.doesNotThrow(() => rememberSelectedRepository(REPOSITORY));
    assert.equal(selectedRepositorySlug(), null);
  });
});

describe("the same turn a repository is prepared", () => {
  it("resolves push_branch and the GitHub surface onto the step after prepare_repository", {
    skip: HAS_COMPILED_MANIFEST
      ? false
      : "run pnpm validate to compile the repository manifest first",
  }, async () => {
    // The lifecycle the ticket is about, dispatched in eve's own order against
    // the compiled manifest: turn.started resolves once before the turn's
    // first tool runs, then prepare_repository selects a repository, then the
    // next model call resolves step.started. eve offers the model the session,
    // turn, and step results together, so what dispatch returns is what the
    // model would carry.
    //
    // A resolver that went back to turn.started would run before the slug was
    // recorded, return null for this lane, and never run again this turn, so
    // its tool would be missing below. That is the half-failure this pins: the
    // GitHub surface resolving while push_branch does not means Foreman can
    // open a pull request it cannot push a branch for.
    const manifest = readCompiledManifest(new URL("../../", import.meta.url));
    const resolvers = await loadCompiledDynamicToolResolvers(
      manifest.dynamicTools,
      manifest.appRoot
    );
    const auth = slack({ intakeOnly: false });
    await inSession(async () => {
      const turn = await openDynamicToolTurn(resolvers, {
        auth,
        id: "repository-lane:same-turn",
      });
      assert.deepEqual(
        await turn.dispatch("turn.started"),
        [],
        "a bare-slug Slack turn starts with no repository capability at all"
      );
      assert.equal((await prepare(auth, REPOSITORY)).success, true);
      const names = new Set(
        (await turn.dispatch("step.started")).map((tool) => tool.name)
      );
      for (const tool of GATED_TOOLS) {
        assert.ok(names.has(tool), `${tool} resolves on the following step`);
      }
      assert.equal(
        [...names].filter((name) => GITHUB_TOOL_NAME.test(name)).length,
        31,
        "the GitHub surface resolves on the same step as push_branch"
      );
    });
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
