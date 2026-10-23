import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LinearAgentSessionEvent } from "eve/channels/linear";

const {
  askFromName,
  buildLinearContext,
  isTriageIntakeAsk,
  LINEAR_TRIAGE_ROUTE,
} = await import("./linear-context.js");

function makeEvent(overrides: {
  action: string;
  issue?: { id: string } | null;
  requester?: { id: string; displayName?: string; name?: string };
}): LinearAgentSessionEvent {
  return {
    action: overrides.action,
    agentSession: {
      id: "session-1",
      ...(overrides.issue === undefined ? {} : { issue: overrides.issue }),
    },
    delivery: { event: undefined, id: undefined },
    kind: "agent_session",
    previousComments: [],
    raw: {},
    ...(overrides.requester
      ? {
          agentActivity: {
            content: {},
            id: "activity-1",
            user: overrides.requester,
          },
        }
      : {}),
  };
}

describe("buildLinearContext", () => {
  it("points every created and prompted dispatch at triage for customer reports", () => {
    for (const action of ["created", "prompted"]) {
      const context = buildLinearContext(
        makeEvent({ action, issue: { id: "issue-1" } })
      );
      assert.deepEqual(context, [LINEAR_TRIAGE_ROUTE]);
    }
  });

  it("leaves the follow-up decision to reply_to_requester and keeps other comments out of the thread", () => {
    for (const rule of [
      "pass your answer to reply_to_requester",
      "returns posted false with an outcome, their reply needed nothing from you: post nothing anywhere",
      "On a follow-up, post no new ticket comment",
      "A result with an error is a failed delivery",
      "Never comment under that thread comment any other way",
    ]) {
      assert.ok(LINEAR_TRIAGE_ROUTE.includes(rule), rule);
    }
  });

  it("returns null for unsupported actions", () => {
    assert.equal(buildLinearContext(makeEvent({ action: "updated" })), null);
  });

  it("includes the requester name as context when Linear provides it", () => {
    const context = buildLinearContext(
      makeEvent({
        action: "created",
        issue: { id: "issue-1" },
        requester: { displayName: "Ada Lovelace", id: "user-1" },
      })
    );
    assert.ok(context);
    assert.ok(
      context.some(
        (line) =>
          line.startsWith("This Linear session was opened by Ada Lovelace.") &&
          line.includes("'Ask from <name>' link, that person is the requester")
      )
    );
  });

  it("names the 'Ask from' requester and never the session opener", () => {
    const context = buildLinearContext(
      makeEvent({
        action: "prompted",
        issue: { id: "issue-1" },
        requester: { displayName: "Aaron Fraga", id: "user-1" },
      }),
      "Jordan Ago"
    );
    assert.ok(context);
    const lines = context.slice(1);
    assert.ok(
      lines.some((line) => line.startsWith("The requester is Jordan Ago"))
    );
    assert.ok(!lines.some((line) => line.includes("Aaron Fraga")));
  });
});

describe("askFromName", () => {
  it("reads the name from the first 'Ask from' attachment", () => {
    assert.equal(
      askFromName([
        "Slack thread",
        " Ask from Andrea Estifano ",
        "Ask from Other",
      ]),
      "Andrea Estifano"
    );
  });

  it("returns null without an 'Ask from' attachment", () => {
    assert.equal(askFromName([]), null);
    assert.equal(askFromName(["Support conversation", "Ask from "]), null);
  });
});

describe("isTriageIntakeAsk", () => {
  const ask = (url: string, title = "Ask from Andrea Estifano") => [
    { title, url },
  ];
  const thread = (channel: string) =>
    `https://fegrowthpartner.slack.com/archives/${channel}/p1791000000000100`;

  it("accepts an 'Ask from' link into a triage intake or migration channel", () => {
    for (const channel of [
      "C0BBPVC3N2X",
      "C0BC011NAQL",
      "C0BQM9V6P47",
      "C0C6DM2MB39",
      "C0C8XP8HAFL",
    ]) {
      assert.equal(isTriageIntakeAsk(ask(thread(channel))), true, channel);
    }
  });

  it("accepts a ticket that links the support conversation it came from", () => {
    assert.equal(
      isTriageIntakeAsk([
        { title: "Support conversation", url: "https://app.example/c/1" },
      ]),
      true
    );
    assert.equal(
      isTriageIntakeAsk([{ title: "Support conversations", url: "https://x" }]),
      false
    );
  });

  it("rejects other channels, other titles, and malformed URLs", () => {
    assert.equal(isTriageIntakeAsk(ask(thread("C0BLFDUN6Q7"))), false);
    assert.equal(
      isTriageIntakeAsk(ask(thread("C0BBPVC3N2X"), "Slack thread")),
      false
    );
    for (const url of [
      "https://fegrowthpartner.slack.com/archives/C0BBPVC3N2X",
      "http://fegrowthpartner.slack.com/archives/C0BBPVC3N2X/p1",
      "https://evil.example/archives/C0BBPVC3N2X/p1",
      "https://fegrowthpartner.slack.com.evil.example/archives/C0BBPVC3N2X/p1",
      `https://fegrowthpartner.slack.com/archives/C0BBPVC3N2X/${"p".repeat(2048)}`,
      "not a url",
    ]) {
      assert.equal(isTriageIntakeAsk(ask(url)), false, url);
    }
    assert.equal(isTriageIntakeAsk([]), false);
  });
});
