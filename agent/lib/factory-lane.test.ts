import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { DynamicResolveContext } from "eve/skills";
import {
  factorySkillAvailable,
  hasFactoryIntent,
  isFactoryRequest,
  stampFactoryIntent,
} from "./factory-lane.js";
import { repositoryFromAuth } from "./repository.js";
import { githubFactoryAuth, slackSessionAuth } from "./session-auth.js";

// The skill's markdown comes from prompts.ts, which reads these at module load
// (both auth providers live in constants.ts).
process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??=
  "planet-scale-read-only-foreman/acquisity-foreman-planet-scale";

const { default: factoryPipeline } = await import(
  "../skills/factory-pipeline.js"
);

const REPOSITORY = "Acquisity/Foreman";
const PIPELINE_HEADING = /Factory pipeline/u;

const SLACK_AUTH: SessionAuthContext = {
  attributes: {
    author_type: "user",
    channel_id: "C0FACTORYLANE",
    user_id: "U0FACTORYLANE",
  },
  authenticator: "slack-webhook",
  issuer: "slack:T0FACTORYLANE",
  principalId: "slack:T0FACTORYLANE:U0FACTORYLANE",
  principalType: "user",
};

const GITHUB_AUTH: SessionAuthContext = {
  attributes: { repository: REPOSITORY, user_login: "factory-lane" },
  authenticator: "github-webhook",
  issuer: "github:Acquisity",
  principalId: "github:1",
  principalType: "user",
};

// The four lanes, each composed by the same helper its channel calls.
const lanes = {
  "autonomous-factory": () => githubFactoryAuth(GITHUB_AUTH, REPOSITORY, 7),
  "repository-interactive": () =>
    slackSessionAuth(SLACK_AUTH, {
      intakeOnly: false,
      repository: REPOSITORY,
    }),
  slack: () => slackSessionAuth(SLACK_AUTH, { intakeOnly: false }),
  "slack-intake-only": () => slackSessionAuth(SLACK_AUTH, { intakeOnly: true }),
};

/** Resolves the skill exactly as eve's dynamic skill lifecycle would. */
const resolveSkill = (auth: SessionAuthContext) => {
  const ctx = {
    channel: { kind: "slack" },
    messages: [],
    session: { auth: { current: auth, initiator: auth }, id: "factory-lane" },
  } as DynamicResolveContext;
  return factoryPipeline.events["turn.started"]?.({}, ctx);
};

describe("explicit factory intent", () => {
  it("reads an explicit request for the factory out of the message", () => {
    assert.ok(isFactoryRequest("run the factory on this"));
    assert.ok(isFactoryRequest("Use FACTORY mode please"));
  });

  it("does not read intent out of ordinary work requests", () => {
    assert.ok(!isFactoryRequest("please fix the failing billing test"));
    assert.ok(!isFactoryRequest("refactoring the intake handler"));
    assert.ok(!isFactoryRequest(""));
  });

  it("bounds the text it matches", () => {
    assert.ok(!isFactoryRequest(`${"a".repeat(10_000)} factory`));
  });

  it("carries the stamp the channel applied", () => {
    assert.ok(!hasFactoryIntent(SLACK_AUTH));
    assert.ok(hasFactoryIntent(stampFactoryIntent(SLACK_AUTH)));
    assert.ok(!hasFactoryIntent(null));
  });
});

describe("factory skill by session lane", () => {
  it("withholds the skill from ordinary Slack", async () => {
    const auth = lanes.slack();
    assert.ok(!factorySkillAvailable(auth));
    assert.equal(await resolveSkill(auth), null);
  });

  it("offers it to ordinary Slack that explicitly asks for the factory", () => {
    const auth = slackSessionAuth(SLACK_AUTH, {
      factoryIntent: isFactoryRequest("take this through the factory"),
      intakeOnly: false,
    });
    assert.ok(factorySkillAvailable(auth));
  });

  it("withholds it from intake-only Slack", async () => {
    const auth = lanes["slack-intake-only"]();
    assert.ok(!factorySkillAvailable(auth));
    assert.equal(await resolveSkill(auth), null);
  });

  it("withholds it from intake-only Slack that names a repository", () => {
    const auth = slackSessionAuth(SLACK_AUTH, {
      intakeOnly: true,
      repository: REPOSITORY,
    });
    assert.ok(repositoryFromAuth(auth));
    assert.ok(!factorySkillAvailable(auth));
  });

  it("offers it to intake-only Slack only on explicit trusted intent", () => {
    const trusted = slackSessionAuth(SLACK_AUTH, {
      factoryIntent: true,
      intakeOnly: true,
    });
    assert.ok(factorySkillAvailable(trusted));
    // The Slack channel trusts every admitted author, so drop the stamp
    // directly to prove trust is a separate condition and not decoration.
    const untrusted: SessionAuthContext = {
      ...trusted,
      attributes: { ...trusted.attributes, trusted: "false" },
    };
    assert.ok(!factorySkillAvailable(untrusted));
  });

  it("offers it to repository-selected interactive work", async () => {
    const auth = lanes["repository-interactive"]();
    assert.ok(factorySkillAvailable(auth));
    const skill = await resolveSkill(auth);
    assert.ok(skill);
    assert.match(skill.markdown, PIPELINE_HEADING);
  });

  it("leaves an autonomous factory run its inline pipeline", async () => {
    const auth = lanes["autonomous-factory"]();
    // The skill would duplicate FACTORY_PROMPT, which embeds the same text.
    assert.ok(!factorySkillAvailable(auth));
    assert.equal(await resolveSkill(auth), null);
  });
});

describe("authority boundary", () => {
  it("gives a free-text repository token neither repository nor factory authority", () => {
    // What the Slack channel would extract from this message is nothing: a
    // bare slug is not a repository URL, so no repository is stamped.
    const auth = slackSessionAuth(SLACK_AUTH, {
      factoryIntent: isFactoryRequest("look at Acquisity/Foreman for me"),
      intakeOnly: false,
    });
    assert.equal(repositoryFromAuth(auth), null);
    assert.ok(!factorySkillAvailable(auth));
  });

  it("gives an intake-only free-text token no factory authority either", () => {
    const auth = slackSessionAuth(SLACK_AUTH, {
      factoryIntent: isFactoryRequest("channels/github.ts and lib/utils"),
      intakeOnly: true,
    });
    assert.equal(repositoryFromAuth(auth), null);
    assert.ok(!factorySkillAvailable(auth));
  });
});
