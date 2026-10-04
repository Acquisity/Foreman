import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { LinearAgentSessionEvent } from "eve/channels/linear";
import {
  STATUS_ONLY_FOLLOW_UP,
  withFollowUpOutcome,
} from "../channels/linear.js";
import { buildLinearContext, LINEAR_TRIAGE_ROUTE } from "./linear-context.js";
import {
  parseWidgetFeedbackMarker,
  WIDGET_FEEDBACK_PROJECT_ID,
  widgetFeedbackContext,
  widgetFeedbackRoute,
} from "./widget-feedback.js";

const LINE =
  "<!-- chat-widget-feedback conversation=conv-1 message=msg-2 run=run-3 replay=abc123 at=2026-09-27T16:45:17.000Z -->";

const DESCRIPTION = `## Report
Reported by: Customer
What went wrong: it told me to open a menu that does not exist
## Conversation
Workspace: Trivox AI (org-1)
Foreman run: run-3
### Transcript (oldest first, customer-visible turns only, last 12 turns max)
Customer: where do I add inboxes?
Foreman: Open Settings > Inboxes.
${LINE}
`;

/** Answers the issue read with a fixed project and description. */
const linearReturning = (
  project: string | null,
  description = DESCRIPTION
) => ({
  fetch: (async () =>
    Response.json({
      data: {
        issue: {
          description,
          project: project === null ? null : { id: project },
        },
      },
    })) as typeof fetch,
});

const credentials = { accessToken: "token" };

describe("parseWidgetFeedbackMarker", () => {
  it("reads the trailing machine line", () => {
    assert.deepEqual(parseWidgetFeedbackMarker(DESCRIPTION), {
      at: "2026-09-27T16:45:17.000Z",
      conversation: "conv-1",
      message: "msg-2",
      replay: "abc123",
      run: "run-3",
    });
  });

  it("reads an older line without replay and time", () => {
    assert.deepEqual(
      parseWidgetFeedbackMarker(
        "<!-- chat-widget-feedback conversation=conv-1 message=msg-2 run=run-3 -->"
      ),
      {
        at: null,
        conversation: "conv-1",
        message: "msg-2",
        replay: null,
        run: "run-3",
      }
    );
  });

  it("maps none to null", () => {
    assert.deepEqual(
      parseWidgetFeedbackMarker(
        "<!-- chat-widget-feedback conversation=conv-1 message=none run=none replay=none at=2026-09-27T16:45:17Z -->"
      ),
      {
        at: "2026-09-27T16:45:17Z",
        conversation: "conv-1",
        message: null,
        replay: null,
        run: null,
      }
    );
  });

  it("returns null when the line is missing", () => {
    assert.equal(parseWidgetFeedbackMarker("## Report\nnothing here"), null);
  });

  it("returns null for malformed values", () => {
    for (const bad of [
      "<!-- chat-widget-feedback conversation= message=m run=r -->",
      "<!-- chat-widget-feedback conversation=c run=r message=m -->",
      "<!-- chat-widget-feedback conversation=c;drop message=m run=r -->",
      "<!-- chat-widget-feedback conversation=none message=m run=r -->",
      "<!-- chat-widget-feedback conversation=c message=m run=r at=2026 replay=x -->",
      "<!-- chat-widget-feedback conversation=c message=m run=r replay=a/b -->",
      `<!-- chat-widget-feedback conversation=${"a".repeat(129)} message=m run=r -->`,
    ]) {
      assert.equal(parseWidgetFeedbackMarker(bad), null, bad);
    }
  });

  it("ignores a quoted line that is not the last one", () => {
    assert.equal(parseWidgetFeedbackMarker(`${LINE}\nCustomer: thanks`), null);
  });

  it("ignores a marker quoted at the end of a transcript line", () => {
    assert.equal(parseWidgetFeedbackMarker(`Customer: ${LINE}\n`), null);
  });
});

describe("widgetFeedbackContext", () => {
  it("routes an issue in the widget project to the playbook with its ids", async () => {
    const route = await widgetFeedbackContext(
      "issue-1",
      credentials,
      linearReturning(WIDGET_FEEDBACK_PROJECT_ID)
    );
    assert.ok(route);
    assert.ok(route.includes("Load the widget-feedback skill"));
    assert.ok(
      route.includes(
        "conversation conv-1, message msg-2, run run-3, Sentry replay abc123, reported at 2026-09-27T16:45:17.000Z"
      )
    );
  });

  it("still routes a widget ticket whose line is missing", async () => {
    const route = await widgetFeedbackContext(
      "issue-1",
      credentials,
      linearReturning(WIDGET_FEEDBACK_PROJECT_ID, "## Report\n")
    );
    assert.equal(route, widgetFeedbackRoute(null));
  });

  it("leaves every other issue on today's path", async () => {
    const routes = await Promise.all(
      ["other-project", null].map((project) =>
        widgetFeedbackContext("issue-1", credentials, linearReturning(project))
      )
    );
    assert.deepEqual(routes, [null, null]);
  });
});

describe("buildLinearContext with a route", () => {
  const event = {
    action: "created",
    agentSession: { id: "session-1", issue: { id: "issue-1" } },
    delivery: { event: undefined, id: undefined },
    kind: "agent_session",
    previousComments: [],
    raw: {},
  } satisfies LinearAgentSessionEvent;

  it("replaces triage with the widget route", () => {
    const route = widgetFeedbackRoute(null);
    assert.deepEqual(buildLinearContext(event, null, route), [route]);
  });

  it("gives a widget session none of triage's requester lines", () => {
    const route = widgetFeedbackRoute(null);
    const opened = {
      ...event,
      agentSession: {
        ...event.agentSession,
        creator: { id: "user-1", name: "Sam" },
      },
    } as LinearAgentSessionEvent;
    assert.deepEqual(buildLinearContext(opened, "Jane", route), [route]);
    assert.deepEqual(buildLinearContext(opened, null, route), [route]);
  });

  it("keeps triage when no route is given", () => {
    assert.deepEqual(buildLinearContext(event, null, undefined), [
      LINEAR_TRIAGE_ROUTE,
    ]);
  });
});

describe("widget-feedback marker time", () => {
  it("drops a reported-at time that does not parse", () => {
    assert.equal(
      parseWidgetFeedbackMarker(
        "<!-- chat-widget-feedback conversation=conv-1 message=msg-2 run=run-3 replay=none at=bad-date -->"
      )?.at,
      null
    );
  });
});

describe("widget-feedback skill", () => {
  const skill = readFileSync(
    new URL("../skills/widget-feedback/SKILL.md", import.meta.url),
    "utf8"
  );
  const allowed = skill.slice(
    skill.indexOf("## What you may do"),
    skill.indexOf("## 1.")
  );

  it("allows reads and exactly one comment", () => {
    assert.ok(allowed.includes("- Read:"));
    assert.ok(allowed.includes("- Write: exactly one comment on this ticket"));
    assert.equal(allowed.match(/^- Write:/gmu)?.length, 1);
  });

  it("forbids every other write", () => {
    for (const forbidden of [
      "Do not change code, push a branch, or open a pull request",
      "Do not reply to the customer",
      "Do not change the assignee, delegate, state, priority, labels, project, or team",
      "`route_ticket`",
      "`reply_to_requester`",
      "save an investigation document",
    ]) {
      assert.ok(allowed.includes(forbidden), forbidden);
    }
  });

  it("names the causes the diagnosis picks from", () => {
    for (const cause of [
      "Wrong help article",
      "Missing help article",
      "Outdated help article",
      "Wrong lane",
      "Screenshot misread",
      "Gate removed too much",
      "Widget UI bug",
      "Not a real problem",
    ]) {
      assert.ok(skill.includes(`- ${cause}:`), cause);
    }
  });
});

describe("widget-feedback follow-up outcome", () => {
  it("keeps the status-only instruction off a widget-feedback session", () => {
    assert.deepEqual(withFollowUpOutcome(["playbook"], "status", true), [
      "playbook",
    ]);
    assert.deepEqual(withFollowUpOutcome(["triage"], "status", false), [
      "triage",
      STATUS_ONLY_FOLLOW_UP,
    ]);
  });
});
