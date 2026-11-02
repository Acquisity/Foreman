import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const skill = readFileSync(
  new URL("../skills/front-door-intake/SKILL.md", import.meta.url),
  "utf8"
);

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
