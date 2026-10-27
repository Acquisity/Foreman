import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const triageCriticSkill = read(
  "../subagents/critic/skills/triage-critic/SKILL.md"
);
const triageHandlingSkill = read("../skills/triage-handling/SKILL.md");
const triageReportingReference = read(
  "../skills/triage-handling/references/reporting.md"
);
const criticReviewReference = read(
  "../skills/triage-handling/references/critic-review.md"
);
const handoffSkill = read("../skills/engineering-handoff/SKILL.md");
const reviewSection = triageHandlingSkill.slice(
  triageHandlingSkill.indexOf("### Review before routing"),
  triageHandlingSkill.indexOf("## Stage 6: Persist and route")
);

test("the review covers closures, records confidence, and reviews twice at most", () => {
  for (const rule of [
    "a `Duplicate`, a `Platform Limitation`",
    "a `User Error` closing with a lane that could not run or a failure the customer saw",
    "an inbox error set aside as billing",
    "A second objection sends it to the area owner, unproven",
    "run the `engineering-handoff` master search first so the critic can check the master",
  ]) {
    assert.ok(reviewSection.includes(rule), rule);
  }
  assert.ok(!reviewSection.includes("never parks the ticket on a person"));
  assert.ok(!triageHandlingSkill.includes("so the evidence is complete"));
  assert.ok(
    triageHandlingSkill.includes(
      "A `Could not run` lane is a gap, not evidence: name each in `unavailableLanes`"
    )
  );
  for (const rule of [
    "`**Confidence**` line from `decision.confidence`",
    "Every other kind has no hotlane assessment",
    "`Review kind: <review.kind>: <review.reason>`",
    "Always name the master",
    "the duplicate target with why it has the same cause",
    "Second review, only after step 7",
    "An objection, after a first review that also objected: the ticket is blocked",
    "An objection, after a first review that failed: it is the first objection",
    "Then call `route_ticket` with only `issue` and `assignee` set to the area owner",
    "`route_ticket` refuses any other route for this ticket once it is blocked",
  ]) {
    assert.ok(criticReviewReference.includes(rule), rule);
  }
  assert.ok(
    triageReportingReference.includes(
      "**Confidence**: verdict <0.00>, classification <0.00>, path <0.00>"
    )
  );
  assert.ok(triageReportingReference.includes("Not required: <review.reason>"));
  assert.ok(
    handoffSkill.includes(
      "Stage 5 runs it before the critic review and records the chosen master or `none eligible` in the document"
    )
  );
});

test("a sending-inbox report is billing-checked before it can be a bug or a duplicate", () => {
  const billingCheck = readFileSync(
    new URL(
      "../skills/triage-handling/references/billing-check.md",
      import.meta.url
    ),
    "utf8"
  );
  assert.ok(
    triageHandlingSkill.includes(
      "[references/billing-check.md](references/billing-check.md)"
    )
  );
  for (const rule of [
    "An inbox error is billing until this check says otherwise",
    "whether the subscription is paid, and whether payments are failing",
    "No read here reaches the domain supplier",
    "`domainsLive: null`",
    "never a duplicate link",
  ]) {
    assert.ok(billingCheck.includes(rule), rule);
  }
  assert.ok(
    triageHandlingSkill.includes(
      "if `unproven` lists the billing check as missing, run it and call again"
    )
  );
  assert.ok(
    handoffSkill.includes("Stage 5 loads it only to run the master search")
  );
  assert.ok(
    triageCriticSkill.includes(
      "`billing_inbox`: an inbox error was set aside as billing"
    )
  );
});

test("the critic judges closures and master matches, and is told how many reviews it gives", () => {
  for (const rule of [
    "## Reviewing a closure",
    "`duplicate`: `master_match` judges the duplicate target",
    "`platform_limitation`: `classification` and `alternatives`",
    "`user_error`: the document names an evidence lane that could not run",
    "A missing master search is a gap in the evidence, not a reason to mark `master_match` `NOT_APPLICABLE`",
    "## Two reviews at most",
    "A second objection stops the ticket",
  ]) {
    assert.ok(triageCriticSkill.includes(rule), rule);
  }
  assert.ok(!triageCriticSkill.includes("exactly once per ticket"));
});
