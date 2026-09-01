import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { DynamicResolveContext } from "eve/skills";
import {
  FACTORY_REQUESTS,
  NOT_FACTORY_REQUESTS,
} from "./factory-intent-fixtures.js";
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
const { onAgentSession } = await import("../channels/linear.js");
const { onMessage } = await import("../channels/eve.js");

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

// A production eve caller, as `vercelOidc()` resolves one: no factory stamp
// of its own, so the delivered message is the only thing that can add it.
const EVE_AUTH: SessionAuthContext = {
  attributes: {},
  authenticator: "vercel-oidc",
  issuer: "https://oidc.vercel.com/acquisity",
  principalId: "vercel:acquisity:foreman",
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
  it("reads a request that names the factory as a word", () => {
    for (const text of FACTORY_REQUESTS) {
      assert.ok(isFactoryRequest(text), text);
    }
  });

  it("reads no request out of a name, a plain sentence, or a negation", () => {
    for (const text of NOT_FACTORY_REQUESTS) {
      assert.ok(!isFactoryRequest(text), text);
    }
  });

  it("reads the text parts of a structured message", () => {
    assert.ok(isFactoryRequest([{ text: "run the factory", type: "text" }]));
    assert.ok(!isFactoryRequest([{ text: "owner/factory", type: "text" }]));
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

// Linear Agent Sessions and eve are interactive lanes too, so each one is
// dispatched for real here: a gate that only Slack could satisfy would take
// the factory away from a session that explicitly asked for it.
describe("interactive dispatch outside Slack", () => {
  const linearAuth = (
    text: string,
    issueTitle = "Investigate the retry loop"
  ) =>
    onAgentSession({} as never, {
      action: "prompted",
      agentActivity: {
        body: text,
        content: {},
        id: "activity-1",
        user: { displayName: "Aaron Fraga", id: "user-1" },
      },
      agentSession: {
        creator: { displayName: "Aaron Fraga", id: "user-1" },
        id: "session-1",
        issue: { id: "issue-1", identifier: "ENG-1", title: issueTitle },
      },
      delivery: { event: "AgentSessionEvent", id: "delivery-1" },
      kind: "agent_session",
      previousComments: [],
      raw: {},
    })?.auth ?? null;

  it("offers a Linear session the factory when it asks, with no GitHub URL", () => {
    const auth = linearAuth("please take this through the factory");
    assert.ok(auth);
    assert.equal(repositoryFromAuth(auth), null);
    assert.ok(factorySkillAvailable(auth));
  });

  it("withholds it from an ordinary Linear session", () => {
    assert.ok(
      !factorySkillAvailable(linearAuth("why is this retrying twice?"))
    );
  });

  it("reads no Linear intent out of a name or a negation", () => {
    for (const text of NOT_FACTORY_REQUESTS) {
      if (text === "") {
        continue;
      }
      assert.ok(!factorySkillAvailable(linearAuth(text)), text);
      // The issue title is read for the message too when no prompt body is.
      assert.ok(!factorySkillAvailable(linearAuth("look here", text)), text);
    }
  });

  const eveAuth = (message: string, caller: SessionAuthContext | null) =>
    onMessage(
      { eve: { caller, request: new Request("https://foreman.test/eve/v1") } },
      message
    ).auth;

  it("offers a production eve session the factory when it asks", () => {
    for (const text of FACTORY_REQUESTS) {
      const requested = eveAuth(text, EVE_AUTH);
      assert.ok(requested);
      assert.ok(factorySkillAvailable(requested), text);
    }
    for (const text of NOT_FACTORY_REQUESTS) {
      if (text === "") {
        continue;
      }
      assert.ok(!factorySkillAvailable(eveAuth(text, EVE_AUTH)), text);
    }
  });

  it("leaves an unauthenticated eve request without auth to stamp", () => {
    assert.equal(eveAuth("run the factory", null), null);
  });
});
