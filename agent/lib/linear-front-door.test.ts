import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type {
  LinearAgentSessionEvent,
  LinearSessionContext,
} from "eve/channels/linear";
import {
  buildLinearContext,
  LINEAR_FRONT_DOOR_ROUTE,
  LINEAR_TRIAGE_ROUTE,
} from "./linear-context.js";
import { composePrompt, GENERAL_PROMPT, MEMORY } from "./prompts.js";
import { sessionLane } from "./session-lane.js";
import { canUseInvestigationMemory } from "./trust.js";

process.env.LINEAR_CONNECTOR ??= "stub/stub";
const { onAgentSession, sessionRoute } = await import("../channels/linear.js");

const WIDGET_LINE = "This issue is chat widget feedback. Load widget-feedback.";

/**
 * A created session on one issue. The issue id is empty so the pre-model
 * reads (follow-up gate, 'Ask from', widget project), which need Linear, are
 * skipped and each resolves to nothing, as a slow read does.
 */
const created = (identifier: string): LinearAgentSessionEvent => ({
  action: "created",
  agentSession: { id: "s1", issue: { id: "", identifier } },
  delivery: { event: "AgentSessionEvent", id: "d1" },
  kind: "agent_session",
  previousComments: [],
  raw: {},
});

const dispatched = async (identifier: string) => {
  const result = await onAgentSession(
    {} as LinearSessionContext,
    created(identifier)
  );
  assert.ok(result && "context" in result);
  return result.context ?? [];
};

const previous = process.env.FIXY_TRIAGE_TEAMS;
afterEach(() => {
  if (previous === undefined) {
    Reflect.deleteProperty(process.env, "FIXY_TRIAGE_TEAMS");
  } else {
    process.env.FIXY_TRIAGE_TEAMS = previous;
  }
});

describe("Linear front door route (ENG-16061)", () => {
  it("routes a listed team's issue to the front door instead of triage", async () => {
    process.env.FIXY_TRIAGE_TEAMS = "SAN";
    const context = await dispatched("SAN-145");
    assert.equal(context[0], LINEAR_FRONT_DOOR_ROUTE);
    assert.ok(!context.includes(LINEAR_TRIAGE_ROUTE));
    assert.ok(LINEAR_FRONT_DOOR_ROUTE.includes("front-door-intake"));
    // The front door replies to the requester, so it keeps the naming line.
    assert.equal(context.length, 2);
    assert.ok(context[1]?.includes("'Ask from <name>' link"));
  });

  it("omits memory instructions and access only on the front-door route", async () => {
    process.env.FIXY_TRIAGE_TEAMS = "SAN";
    const front = await onAgentSession(
      {} as LinearSessionContext,
      created("SAN-145")
    );
    assert.ok(front && "auth" in front && front.auth);
    const prompt = composePrompt(sessionLane(front.auth));
    assert.equal(canUseInvestigationMemory(front.auth), false);
    assert.ok(!prompt.includes("search_investigation_memory"));
    assert.ok(!prompt.includes("correct_investigation_case"));
    assert.equal(prompt, GENERAL_PROMPT.replace(`${MEMORY}\n\n`, ""));
    process.env.FIXY_TRIAGE_TEAMS = "";
    const triage = await onAgentSession(
      {} as LinearSessionContext,
      created("SAN-145")
    );
    assert.ok(triage && "auth" in triage && triage.auth);
    assert.equal(canUseInvestigationMemory(triage.auth), true);
    assert.equal(composePrompt(sessionLane(triage.auth)), GENERAL_PROMPT);
  });

  it("takes the memory part of the prompt from the current auth", async () => {
    process.env.FIXY_TRIAGE_TEAMS = "SAN";
    const front = await onAgentSession(
      {} as LinearSessionContext,
      created("SAN-145")
    );
    process.env.FIXY_TRIAGE_TEAMS = "";
    const triage = await onAgentSession(
      {} as LinearSessionContext,
      created("SAN-145")
    );
    assert.ok(front && "auth" in front && front.auth);
    assert.ok(triage && "auth" in triage && triage.auth);
    // A session started on triage whose later event is routed to the front
    // door, and the reverse after the setting is cleared.
    assert.equal(
      composePrompt(sessionLane(triage.auth, front.auth)),
      GENERAL_PROMPT.replace(`${MEMORY}\n\n`, "")
    );
    assert.equal(
      composePrompt(sessionLane(front.auth, triage.auth)),
      GENERAL_PROMPT
    );
  });

  it("leaves every other team on today's triage", async () => {
    process.env.FIXY_TRIAGE_TEAMS = "SAN";
    assert.deepEqual(
      await dispatched("ENG-17117"),
      buildLinearContext(created("ENG-17117"))
    );
  });

  it("changes nothing while the setting is empty", async () => {
    for (const setting of [undefined, "", " , "]) {
      if (setting === undefined) {
        Reflect.deleteProperty(process.env, "FIXY_TRIAGE_TEAMS");
      } else {
        process.env.FIXY_TRIAGE_TEAMS = setting;
      }
      for (const identifier of ["SAN-145", "ENG-17117"]) {
        // biome-ignore lint/performance/noAwaitInLoops: each case reads the setting the loop just wrote.
        const context = await dispatched(identifier);
        assert.deepEqual(context, buildLinearContext(created(identifier)));
        assert.equal(context[0], LINEAR_TRIAGE_ROUTE);
      }
    }
  });

  it("keeps the widget-feedback route on a listed team", () => {
    const env = { FIXY_TRIAGE_TEAMS: "SAN" };
    const event = created("SAN-145");
    assert.equal(sessionRoute(event, WIDGET_LINE, env), WIDGET_LINE);
    assert.deepEqual(
      buildLinearContext(event, "Jo", sessionRoute(event, WIDGET_LINE, env)),
      [WIDGET_LINE]
    );
    assert.equal(sessionRoute(event, null, env), LINEAR_FRONT_DOOR_ROUTE);
    assert.equal(sessionRoute(event, null, {}), undefined);
    assert.equal(sessionRoute(created("ENG-1"), null, env), undefined);
  });

  it("shares the requester-thread rules with the triage route word for word", () => {
    for (const rule of [
      "send them exactly one message with reply_to_requester, your answer, and never the investigation itself.",
      "post nothing anywhere and end the session with one short line.",
      "Never comment under that thread comment any other way, since everything there reaches the requester.",
    ]) {
      assert.ok(LINEAR_TRIAGE_ROUTE.includes(rule), rule);
      assert.ok(LINEAR_FRONT_DOOR_ROUTE.includes(rule), rule);
    }
    assert.ok(!LINEAR_FRONT_DOOR_ROUTE.includes("triage-investigate"));
    assert.ok(LINEAR_FRONT_DOOR_ROUTE.includes("billing-triage"));
  });
});
