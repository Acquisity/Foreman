import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const billingSkill = readFileSync(
  new URL("../skills/billing-triage/SKILL.md", import.meta.url),
  "utf8"
);

test("billing triage reads the complete Linear issue contract", () => {
  const issueRead = billingSkill.indexOf("1. Step 1 issue read:");
  const identityGate = billingSkill.indexOf("3. Identity gate:");
  const stepOne = billingSkill.indexOf("## Step 1: Read the Linear issue");
  const stepTwo = billingSkill.indexOf("## Never move money", stepOne);

  assert.ok(issueRead >= 0);
  assert.ok(identityGate > issueRead);
  assert.ok(stepOne >= 0);
  assert.ok(stepTwo > stepOne);

  const issueReadSection = billingSkill.slice(stepOne, stepTwo);
  assert.ok(
    issueReadSection.includes(
      "title, description, attachments, links, comments, labels, priority, project, assignee, requester, and relations"
    )
  );
});

test("a ticket Fixy owns is handed off, never re-routed, and a closed one is not reopened", () => {
  for (const rule of [
    'When `decide_billing` returns `handTo: "fixy"`',
    "`lanes` including `billing`",
    "never call `decide_billing` or `route_ticket` again on new facts",
    "On a Done or Canceled ticket, answer the follow-up and change no state.",
    "Only on a ticket Fixy does not own, a follow-up whose only ask is to move the ticket to a closed status",
    "On a ticket Fixy owns, never move status",
    "Fixy judges that approval",
  ]) {
    assert.ok(billingSkill.includes(rule), rule);
  }
  assert.ok(!billingSkill.includes("reopen a closed ticket"));
});

test("Fixy routing precedes the non-Fixy Aaron and Todo route", () => {
  const routing = billingSkill.slice(billingSkill.indexOf("## Routing"));
  const fixy = routing.indexOf(
    'When `decide_billing` returns `handTo: "fixy"`'
  );
  assert.ok(fixy >= 0);
  assert.ok(fixy < routing.indexOf('`assignee: "Aaron Fraga"`'));
  assert.ok(fixy < routing.indexOf('`state: "Todo"`'));
  assert.ok(routing.includes("the ticket's `issue`, the pinned workspace"));
  assert.ok(routing.includes("Only on tickets Fixy does not own"));
});
