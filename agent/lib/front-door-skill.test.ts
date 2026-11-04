import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ProviderClient } from "./executor/operations.js";
import { routeTicket } from "./linear-api.js";
import { SUPPORT_OWNER } from "./owner-map.js";
import { fakeLinear, json } from "./route-ticket-fixtures.js";

const skill = readFileSync(
  new URL("../skills/front-door-intake/SKILL.md", import.meta.url),
  "utf8"
);

const ASSIGNEE = /`assignee: "([^"`]+)"`/u;
const BOLD = /\*\*[^*]+\*\*/u;

const section = (heading: string) => {
  const start = skill.indexOf(`## ${heading}`);
  assert.ok(start >= 0, heading);
  const end = skill.indexOf("\n## ", start + 3);
  return skill.slice(start, end < 0 ? undefined : end);
};

test("the front door names everything it never does", () => {
  const never = section("Never in this skill");
  for (const name of [
    "`check_regression`",
    "`decide_triage`",
    "`save_investigation_document`",
    "The critic",
    "`incident-hotlane`",
    "`engineering-handoff`",
    "Investigation memory reads or writes",
    "`search_investigation_memory`",
    "`record_investigation_case`",
    "`correct_investigation_case`",
    "PlanetScale",
    "Sentry",
    "Axiom",
    "Inngest",
    "`prepare_repository` for anything but answering a how-to",
  ]) {
    assert.ok(never.includes(name), name);
  }
  // The only repository read is the how-to answer's.
  const rest = skill.replace(never, "");
  assert.equal(rest.split("`prepare_repository`").length - 1, 1);
  assert.ok(
    section("3. How-to or expected behaviour").includes("`prepare_repository`")
  );
  for (const tool of [
    "check_regression",
    "decide_triage",
    "save_investigation_document",
    "record_investigation_case",
    "search_investigation_memory",
  ]) {
    assert.ok(!rest.includes(tool), tool);
  }
});

test("the procedure runs in order and hands off last", () => {
  const order = [
    "## 1. Read the ticket",
    "`classify_ask`",
    "## 2. Find the workspace",
    "`lookup_customer`",
    "## 3. How-to or expected behaviour",
    "`find_help_article`",
    "## 4. Known issue",
    "`find_related_issues`",
    "`decide_prior_work`",
    "## 5. Missing details",
    "## 6. Hand the report to Fixy",
    "Call `hand_to_fixy` once",
    "## 7. End the session",
    "## 8. Follow-ups after the hand-off",
  ];
  let at = -1;
  for (const marker of order) {
    const next = skill.indexOf(marker, at + 1);
    assert.ok(next > at, `${marker} comes after the step before it`);
    at = next;
  }
});

test("money asks go to billing, and errors are real reports for Fixy", () => {
  assert.ok(
    section("1. Read the ticket").includes("load the billing-triage skill")
  );
  const howTo = section("3. How-to or expected behaviour");
  assert.ok(howTo.includes("isn't working"));
  assert.ok(howTo.includes("Fixy decides that"));
  assert.ok(howTo.includes("state `Canceled`"));
});

test("a known issue joins only when open, and a refusal hands off", () => {
  const known = section("4. Known issue");
  assert.ok(known.includes("that issue is open (not completed or canceled)"));
  assert.ok(known.includes("`duplicateOf`"));
  assert.ok(known.includes("When `route_ticket` refuses"));
  assert.ok(known.includes("name the candidate in `notes`"));
});

test("the requester is asked once and told nothing on a plain hand-off", () => {
  assert.ok(section("5. Missing details").includes("Never ask twice."));
  assert.ok(
    section("6. Hand the report to Fixy").includes(
      "Post nothing to the requester on a plain hand-off"
    )
  );
  const followUps = section("8. Follow-ups after the hand-off");
  assert.ok(followUps.includes("Do not restart anything."));
  assert.ok(followUps.includes("call `hand_to_fixy` again"));
});

test("the skill follows the agent-facing text rules", () => {
  assert.ok(!skill.includes("—"), "no em dashes");
  assert.ok(!BOLD.test(skill), "no bold");
});

for (const [heading, state] of [
  ["3. How-to or expected behaviour", "Canceled"],
  ["4. Known issue", "Duplicate"],
] as const) {
  test(`the prescribed ${state} route succeeds for a James-held report without Bug`, async () => {
    const step = section(heading);
    const assignee = ASSIGNEE.exec(step)?.[1];
    const linear = fakeLinear({
      teamLabels: [{ id: "user-error", name: "User Error" }],
      ticketAssignee: { id: "james", name: "James Keeble" },
      ticketLabels: [],
    });
    const client: ProviderClient = (request) =>
      request.operation === "linear.Users"
        ? json({
            data: {
              users: { nodes: [{ id: "support", name: SUPPORT_OWNER }] },
            },
          })
        : linear.fetchStub(request);
    const result = await routeTicket(
      {
        addLabels:
          state === "Canceled"
            ? ["Customer reported", "User Error"]
            : ["Customer reported"],
        assignee,
        issue: "ENG-1",
        state,
        ...(state === "Duplicate"
          ? { duplicateOf: "ENG-9", inheritAssigneeFrom: "ENG-9" }
          : {}),
      },
      { client }
    );
    assert.equal(assignee, SUPPORT_OWNER);
    const [update] = linear.updates();
    assert.ok(update);
    assert.equal(
      (update.variables.input as Record<string, unknown>).assigneeId,
      "support"
    );
    assert.ok(!result.labels.includes("Bug"));
    assert.equal(linear.relations.length, state === "Duplicate" ? 1 : 0);
    if (state === "Duplicate") {
      assert.ok(
        result.warnings.some((warning) => warning.includes("not inherited"))
      );
    }
  });
}

test("an eligible known issue assignee takes precedence over the support fallback", async () => {
  const assignee = ASSIGNEE.exec(section("4. Known issue"))?.[1];
  const linear = fakeLinear();
  await routeTicket(
    {
      assignee,
      duplicateOf: "ENG-9",
      inheritAssigneeFrom: "ENG-9",
      issue: "ENG-1",
      state: "Duplicate",
    },
    { client: linear.fetchStub }
  );
  const [update] = linear.updates();
  assert.ok(update);
  assert.equal(
    (update.variables.input as Record<string, unknown>).assigneeId,
    "u-anuj"
  );
});

test("a handoff comment marks follow-ups, and Bug without it still gets intake", () => {
  assert.ok(
    section("1. Read the ticket").includes(
      "already has the `## Fixy handoff` comment"
    )
  );
  assert.ok(
    section("1. Read the ticket").includes("Fixy may already have started")
  );
});

test("new details after a finished run get a top-level escalation without automatic retry", () => {
  const follow = section("8. Follow-ups after the hand-off");
  assert.ok(follow.includes("`factory:needs-you` or `factory:failed`"));
  assert.ok(follow.includes("top-level ticket comment"));
  assert.ok(follow.includes("a person should decide whether to re-run Fixy"));
  assert.ok(follow.includes("do not remove or re-add labels automatically"));
});

test("a duplicate retries only missing optional labels once", () => {
  const known = section("4. Known issue");
  assert.ok(
    known.includes("retry once without precisely those missing labels")
  );
  assert.ok(
    known.includes(
      "keeping the valid labels, assignee arguments and duplicate target"
    )
  );
  assert.ok(known.includes("refuses for another reason or the retry fails"));
});

test("an undecided prior-work call continues without an investigation document", () => {
  const known = section("4. Known issue");
  assert.ok(
    known.includes("`decided: false`, continue to missing details or handoff")
  );
  assert.ok(known.includes("create no investigation document"));
});
