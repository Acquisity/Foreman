import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const triageCriticSkill = read(
  "../subagents/critic/skills/triage-critic/SKILL.md"
);
const triageSkill = read("../skills/triage/SKILL.md");
const triageReportingReference = read(
  "../skills/triage/references/reporting.md"
);
const criticReviewReference = read(
  "../skills/triage/references/critic-review.md"
);
const handoffSkill = read("../skills/triage/references/engineering-handoff.md");
const reviewSection = triageSkill.slice(
  triageSkill.indexOf("Review before routing:"),
  triageSkill.indexOf("## Stage 6: Persist and route")
);

test("the review covers closures, records confidence, and reviews twice at most", () => {
  // Which decisions need review is decided in code (review.required); the
  // protocol names every kind it checks.
  for (const rule of [
    "`duplicate`, `platform_limitation`, `user_error` (a closure with an evidence lane that could not run, or a failure the customer saw), or `billing_inbox` (an inbox error set aside as billing, not code)",
    "The critic objected twice in a row",
  ]) {
    assert.ok(criticReviewReference.includes(rule), rule);
  }
  assert.ok(
    reviewSection.includes("a second objection hands the ticket to Aaron")
  );
  assert.ok(
    reviewSection.includes(
      "run the master search in [references/engineering-handoff.md](references/engineering-handoff.md) first so the critic can check the master"
    )
  );
  assert.ok(!reviewSection.includes("never parks the ticket on a person"));
  assert.ok(!triageSkill.includes("so the evidence is complete"));
  assert.ok(
    triageSkill.includes(
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
    'Then call `route_ticket` with only `issue` and `assignee: "Aaron Fraga"`',
    "a developer may not hold one that is not labelled `Bug`",
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
    new URL("../skills/triage/references/billing-check.md", import.meta.url),
    "utf8"
  );
  assert.ok(
    triageSkill.includes(
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
    triageSkill.includes(
      "if `unproven` lists the billing check as missing, run it and call again"
    )
  );
  assert.ok(
    handoffSkill.includes(
      "from Stage 5 only to run the master search before the critic review"
    )
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

test("a decision Jev could not make is not reviewed as a fallback: it is unproven", () => {
  assert.equal(criticReviewReference.includes("fallback"), false);
  assert.ok(
    criticReviewReference.includes(
      "Follow this when `decide_triage` returned `review.required: true`"
    )
  );
  assert.ok(
    reviewSection.includes(
      "or the decision is recorded and any required review has settled the document"
    )
  );
});

test("the Intercom source runs the same Stage 5 review as every ticket", () => {
  assert.ok(!triageSkill.includes("exactly one critic pass"));
  assert.ok(triageSkill.includes("Then run Stages 5 to 7 on it"));
});

test("the critic is sent the packet its echo is checked against", () => {
  for (const rule of [
    "The next three lines are exactly `Document: <document id>`, `Document updatedAt: <updatedAt>`, and `Commit: <the full 40-character SHA",
    "a read-only run writes `read-only` on both document lines",
    "a result whose `reviewed` echo names another ticket, document, version or commit is a failed review, not an objection",
  ]) {
    assert.ok(criticReviewReference.includes(rule), rule);
  }
});

test("the final Review line is saved after routing on every path, not only after the handoff", () => {
  assert.ok(
    triageSkill.includes(
      "After routing reads back, save it once more with its final `**Review**` line"
    )
  );
  assert.ok(!triageSkill.includes("After the handoff reads its writes back"));
});

test("every Engineering Todo decision gets its master search before the review that checks it", () => {
  assert.ok(
    reviewSection.includes(
      "For an `Engineering Todo` path, run the master search in [references/engineering-handoff.md](references/engineering-handoff.md) first"
    )
  );
  assert.ok(
    handoffSkill.includes(
      "When adjudication moves the decision to `Engineering Todo` or changes its cause or code path, Stage 5 runs it again and records the new master before the second review; Stage 6 reuses the latest result."
    )
  );
  assert.ok(
    criticReviewReference.includes(
      "If the corrected decision takes the `Engineering Todo` path and no master search has run for its cause and code path, run the `engineering-handoff` master search and record its master"
    )
  );
});
