import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const triageSkill = readFileSync(
  new URL("../skills/triage-investigate/SKILL.md", import.meta.url),
  "utf8"
);
const triageReportingReference = readFileSync(
  new URL(
    "../skills/triage-investigate/references/reporting.md",
    import.meta.url
  ),
  "utf8"
);
const triageToolsReference = readFileSync(
  new URL("../skills/triage-investigate/references/tools.md", import.meta.url),
  "utf8"
);
const intercomTriageSkill = readFileSync(
  new URL("../skills/intercom-triage-investigate/SKILL.md", import.meta.url),
  "utf8"
);
const handoffSkill = readFileSync(
  new URL("../skills/engineering-handoff/SKILL.md", import.meta.url),
  "utf8"
);
const hotlaneSkill = readFileSync(
  new URL("../skills/incident-hotlane/SKILL.md", import.meta.url),
  "utf8"
);
const slackWordingSkill = readFileSync(
  new URL("../skills/slack-wording/SKILL.md", import.meta.url),
  "utf8"
);

const extractInstruction = (skill: string, start: string, end: string) => {
  const startIndex = skill.indexOf(start);
  const endIndex = skill.indexOf(end, startIndex);

  assert.ok(startIndex >= 0);
  assert.ok(endIndex > startIndex);
  return skill.slice(startIndex, endIndex);
};

test("Stage 5 names the Linear state for every handling path", () => {
  assert.ok(
    triageSkill.includes(
      "`Engineering Todo` is `Todo` (the master owns the work; the report stays open under it), `Duplicate` is `Duplicate`, `Backlog/low-impact` is `Backlog`, `Support/Financial` and `Support/Product follow-up` are `Todo` (a person still acts), and `Resolved by triage`, `User Error`, and `Platform Limitation` are `Done`."
    )
  );
});

test("shared triage exposes one seven-stage workflow with settled fact boundaries", () => {
  const stages = [
    "Stage 1: Establish the case",
    "Stage 2: Resolve customer identity once",
    "Stage 3: Check existing work and frame the investigation",
    "Stage 4: Investigate",
    "Stage 5: Decide handling",
    "Stage 6: Persist and route",
    "Stage 7: Finish the attended response and memory bookkeeping",
  ];

  let previousIndex = -1;
  for (const stage of stages) {
    const stageIndex = triageSkill.indexOf(`## ${stage}`);
    assert.ok(stageIndex > previousIndex);
    previousIndex = stageIndex;
  }

  assert.equal(triageSkill.match(/^## Stage \d:/gmu)?.length, 7);
  assert.equal(triageSkill.match(/^Purpose:/gmu)?.length, 7);
  assert.equal(triageSkill.match(/^Inputs:/gmu)?.length, 7);
  assert.equal(triageSkill.match(/^Completion:/gmu)?.length, 7);
  assert.ok(triageSkill.includes("runtime's `intakeOnly` value as a fact"));
  assert.ok(triageSkill.includes("including `null`"));
  assert.ok(
    triageSkill.includes(
      "Reopen it only when genuinely new evidence conflicts with that result"
    )
  );
  assert.ok(
    triageSkill.includes(
      "without reopening trusted intake, identity, or completed evidence unless new conflicting evidence appears"
    )
  );
});

test("shared triage preserves every evidence lane and exact tool catalog", () => {
  const evidenceLanes = [
    "Search investigation memory",
    "Locate it in the code",
    "Check the data",
    "Background work",
    "Errors, crashes, stack traces",
    "Anything the other lanes do not carry",
    "Email delivery, bounces, spam placement",
    "Instantly workspace membership",
    "What the user actually did",
    "Deployment or edge failures",
    "The conversation behind the report",
  ];
  const toolCatalogs = [
    "Repository (root tools, no prefix)",
    "Investigation memory (root tools, no prefix)",
    "PlanetScale (`planetscale__`)",
    "Instantly (root tools, no prefix)",
    "Linear (`linear__`)",
    "Inngest (`inngest__`)",
    "Sentry (`sentry__`)",
    "Axiom (`axiom__`)",
    "PostHog (`posthog__`)",
    "Lucent (`lucent__`)",
    "Jam (`jam__`)",
    "Vercel (`vercel__`)",
    "Intercom (`intercom__`)",
    "Resend (`resend__`)",
    "Modem (`modem__`)",
  ];

  for (const lane of evidenceLanes) {
    assert.ok(triageSkill.includes(lane), lane);
  }
  for (const catalog of toolCatalogs) {
    assert.ok(triageToolsReference.includes(`## ${catalog}`), catalog);
  }
  assert.ok(triageSkill.includes("[references/tools.md](references/tools.md)"));
  assert.ok(
    triageSkill.includes("[references/reporting.md](references/reporting.md)")
  );
  assert.ok(triageReportingReference.includes("## Linear report template"));
  assert.ok(
    triageReportingReference.includes(
      "## Triage investigation document template"
    )
  );
  assert.ok(triageReportingReference.includes("## Master ticket template"));
  assert.ok(
    triageReportingReference.includes("live in the `engineering-handoff` skill")
  );
  assert.ok(handoffSkill.includes("## Master ticket template"));
});

test("shared triage makes retrieval project-independent", () => {
  const establish = extractInstruction(
    triageSkill,
    "## Stage 1: Establish the case",
    "## Stage 2: Resolve customer identity once"
  );
  const investigate = extractInstruction(
    triageSkill,
    "### Search investigation memory",
    "### Locate it in the code"
  );

  for (const oldInstruction of [
    "A ticket with no project has nothing to search",
    "Unavailable: no Linear project",
    "Pass the project id from the ticket",
    "The project is what picks the product area",
    "route to Aaron Fraga as the triage skill already requires",
  ]) {
    assert.equal(triageSkill.includes(oldInstruction), false, oldInstruction);
  }
  assert.ok(establish.includes("ordinary intake metadata"));
  assert.ok(
    establish.includes(
      "Do not establish, verify, infer, preserve, or route from a product project yet"
    )
  );
  assert.ok(investigate.includes("accepts no Linear project id"));
  assert.ok(investigate.includes("every authorized attended triage surface"));
  assert.ok(investigate.includes("projectless Linear tickets"));
  assert.ok(investigate.includes("tickets that arrive under `Support`"));
  assert.ok(
    triageSkill.includes(
      "PlanetScale is the production database and the only source of current production truth"
    )
  );
  assert.ok(
    triageSkill.includes(
      "Historical memory is analogy only and cannot settle the verdict, duplicate, master, severity, or current blast radius"
    )
  );
});

test("ENG-13175-shaped thread correction is recorded, not argued", () => {
  for (const phrase of [
    "A colleague correcting you in the thread or on the ticket is later evidence",
    "put your overturned conclusion in `ruledOut`",
    "handle it as a correction under Stage 7",
  ]) {
    assert.ok(triageSkill.includes(phrase), phrase);
  }
});

test("ENG-12880-shaped projectless intake searches memory before choosing a project", () => {
  const memorySearch = triageSkill.indexOf(
    "including projectless Linear tickets"
  );
  const projectChoice = triageSkill.indexOf(
    "### Choose the product project from completed evidence"
  );

  assert.ok(memorySearch >= 0);
  assert.ok(projectChoice > memorySearch);
  assert.ok(
    triageSkill.includes(
      "Pass the evidence-backed project to the ticket's one `route_ticket` call"
    )
  );
  assert.ok(
    triageSkill.includes(
      "pass that resulting project id to `record_investigation_case`"
    )
  );
});

test("ENG-13108-shaped Support intake neither gates memory nor triggers fallback", () => {
  assert.ok(
    triageSkill.includes("incoming `Support` project cannot make this decision")
  );
  assert.ok(
    triageSkill.includes(
      "Missing or unmapped intake metadata by itself is never that evidence gap and never triggers Aaron routing"
    )
  );
  assert.ok(
    triageSkill.includes(
      "When Aaron explicitly requests read-only validation during an attended manual test"
    )
  );
  assert.ok(
    triageSkill.includes(
      "apply no Linear mutation and do not record investigation memory"
    )
  );
  assert.ok(
    triageSkill.includes(
      "This is an operator instruction for that test, not a runtime authorization mode"
    )
  );
  assert.ok(
    triageSkill.includes("Do not require or invent a session marker for it")
  );
});

test("shared triage stops unproven claims before classification or routing", () => {
  assert.ok(
    triageSkill.includes(
      "When the deciding confirmation is still missing, take the unproven branch and stop before classification"
    )
  );
  assert.ok(
    triageSkill.includes(
      "Preserve the source ticket's current state, priority, and labels"
    )
  );
  assert.ok(
    triageSkill.includes(
      "Do not create or attach a master, route engineering work, or record investigation memory"
    )
  );
  assert.ok(
    triageSkill.includes(
      "Before stopping, record any safe unblock supported by the completed evidence"
    )
  );
  assert.ok(
    triageSkill.includes(
      "action, owner, current status, and confirmation that it costs the customer neither data nor money"
    )
  );
  assert.ok(
    triageSkill.includes(
      "either the unproven branch has made the unblock explicit"
    )
  );
  assert.ok(triageReportingReference.includes("## Unproven branch reporting"));
  assert.ok(
    triageReportingReference.includes("`**Classification**: Not settled`")
  );
  assert.ok(
    triageReportingReference.includes(
      "Never load `engineering-handoff` or create or attach a master for this branch"
    )
  );
});

test("Slack product triage master searches enforce the 30-day cutoff", () => {
  const skills = [
    {
      end: "\n2. In an intake-only Slack workflow",
      skill: handoffSkill,
      start: "1. Call `find_related_issues`",
    },
    {
      end: "\n3. Create one customer-report issue",
      skill: intercomTriageSkill,
      start: "2. Search current Linear masters no further than 30 days back.",
    },
  ];

  for (const { end, skill, start } of skills) {
    const masterSearchInstruction = extractInstruction(skill, start, end);
    assert.ok(masterSearchInstruction.includes("`find_related_issues`"));
    assert.ok(masterSearchInstruction.includes('`scope: "masters"`'));
    assert.ok(masterSearchInstruction.includes("30 days"));
    assert.ok(masterSearchInstruction.includes("`createdAfter`"));
    assert.ok(!masterSearchInstruction.includes("linear__list_issues"));
    assert.ok(!masterSearchInstruction.includes("8eaf95ab"));
    assert.ok(!masterSearchInstruction.includes("-P30D"));
    assert.ok(!masterSearchInstruction.includes("hasNextPage"));
    assert.ok(skill.includes("created exactly 30 days ago"));
    assert.ok(skill.includes("even by one second"));
    assert.ok(skill.includes("selecting a candidate as the current master"));
    assert.ok(skill.includes("current-master selection and parent attachment"));
    assert.ok(skill.includes("may be related for history"));
    assert.ok(skill.includes("never reused as the parent"));
    assert.ok(!skill.includes("before comparing or attaching anything"));
    assert.ok(skill.includes("current") && skill.includes("blast-radius"));
    assert.ok(skill.includes("similarity"));
    assert.ok(skill.includes("evidence"));
    assert.ok(skill.includes("product-area"));
    assert.ok(skill.includes("duplicate"));
  }
});

test("shared triage preserves unbounded master lookup outside Slack intake", () => {
  const masterSelection = extractInstruction(
    handoffSkill,
    "## Search for the current master",
    "## Content boundary"
  );

  assert.ok(masterSelection.includes("intake-only Slack workflow"));
  assert.ok(masterSelection.includes("including a Linear Agent Session"));
  assert.ok(masterSelection.includes("`createdAfter` is null"));
  assert.ok(masterSelection.includes("no recency filter is applied"));
  assert.ok(
    masterSelection.includes(
      "matching masters are considered regardless of creation date"
    )
  );
  assert.ok(masterSelection.includes("Outside that Slack workflow"));
  assert.ok(masterSelection.includes("do not apply the recency cutoff"));
  assert.ok(masterSelection.includes("In other contexts"));
  assert.ok(masterSelection.includes("eligibility has no recency cutoff"));
});

test("Slack replies exclude internal investigation summaries", () => {
  for (const skill of [triageSkill, intercomTriageSkill]) {
    assert.ok(skill.includes("only") && skill.includes("requester-facing"));
    assert.ok(skill.includes("investigation summary"));
  }

  assert.ok(slackWordingSkill.includes("final post"));
  assert.ok(slackWordingSkill.includes("single-audience message"));
  assert.ok(slackWordingSkill.includes("only the forwardable requester reply"));
  assert.ok(slackWordingSkill.includes("Linear update report"));
  assert.ok(
    slackWordingSkill.includes("progress updates may be conversational")
  );
});

test("triage Stage 6 hands the actionable branch to engineering-handoff", () => {
  const branch = extractInstruction(
    triageSkill,
    "### When the root cause warrants action",
    "### Area-routing roster"
  );
  assert.ok(branch.includes("Load `engineering-handoff`"));
  assert.ok(!branch.includes("linear__list_issues"));
  assert.ok(!triageSkill.includes("## Master ticket template"));
  for (const moved of [
    "## Preconditions",
    "## Match by cause, not symptom",
    "## Search for the current master",
    "## Reuse an existing master",
    "## Create one master",
    "## Read back before finishing",
    "One master per root cause",
    "`fast-lane`",
    "area-routing roster in `triage-investigate` Stage 6",
    "in the product project Stage 6 selected from completed evidence (never the report's incoming intake project",
  ]) {
    assert.ok(handoffSkill.includes(moved), moved);
  }
  for (const excluded of [
    "reserve_triage_master",
    "complete_triage_master_reservation",
    "read_triage_review_verdict",
    "approvalId",
    "Final communication",
  ]) {
    assert.ok(!handoffSkill.includes(excluded), excluded);
  }
});

test("incident-hotlane assesses and never writes", () => {
  for (const kept of [
    "Propose `HOTLANE`",
    "`STANDARD_ENGINEERING`",
    "`NOT_ENGINEERING`",
    "`NEEDS_HUMAN_URGENT`",
    "`fast-lane`",
    "`confirmed_affected`",
    "`potentially_exposed`",
    "Containment",
    "Customer recovery",
    "Permanent prevention",
    "Observability",
    "This skill performs no writes",
  ]) {
    assert.ok(hotlaneSkill.includes(kept), kept);
  }
  for (const excluded of [
    "save_issue",
    "save_comment",
    "save_document",
    "Set `HOTLANE`",
    "triage-critic",
    "After approval:",
    "incident channel",
  ]) {
    assert.ok(!hotlaneSkill.includes(excluded), excluded);
  }
  assert.ok(hotlaneSkill.includes("This skill does not set priority"));
  assert.ok(
    hotlaneSkill.includes(
      "For `HOTLANE` and `STANDARD_ENGINEERING`, Foreman includes the assessment in the critic review"
    )
  );
  assert.ok(
    hotlaneSkill.includes(
      "`NEEDS_HUMAN_URGENT` instead routes directly to a person before any critic review or settled decision"
    )
  );
});

test("triage reviews a Bug with the critic before routing it", () => {
  const review = extractInstruction(
    triageSkill,
    "### Review a Bug before routing it",
    "## Stage 6: Persist and route"
  );
  for (const rule of [
    "This review runs only when the classification is `Bug` and the handling path is not `Duplicate`",
    "a duplicate routes nothing new to engineering",
    "The critic runs exactly once per ticket",
    "Foreman posts one progress line, delegates once, and adjudicates the result once",
    "never parks the ticket on a person",
    "`**Review**: Pending critic`",
    "Load `incident-hotlane`",
    "If the route is `NEEDS_HUMAN_URGENT`, do not call the critic",
    "Post one progress line to the attended thread",
    "the next message the thread receives is the final reply",
    "Delegate to the `critic` subagent exactly once",
    "the full 40-character SHA",
    "Do not pass an `outputSchema`",
    "this reading is the one adjudication",
    "exactly one entry for each of the twelve criterion slugs with no slug missing or repeated",
    "An `APPROVE` with any `FAIL` criterion, a missing or repeated slug, or a non-empty `blocking_findings` is handled as a `CHALLENGE`",
    "A result with an empty `criteria_results` is a review that could not start",
    "None of these is a reason for a second delegation",
    "On `CHALLENGE`, on `INSUFFICIENT_EVIDENCE`, or on a failed review: adjudicate once against the Stage 4 evidence record",
    "When the corrected record no longer supports the classification, change the classification and handling path",
    "read back its adjudicated-evidence `updatedAt`",
    "`**Review**: Adjudicated <that adjudicated-evidence updatedAt> at <commit>: <CHALLENGE | INSUFFICIENT_EVIDENCE | review failure>`",
    "followed by those same clauses",
    "That final read-back `updatedAt` is the settled version the handoff checks",
    "In a read-only run, describe those writes instead of making them",
    "as the literal marker `read-only`",
    "Do not touch the document",
    "Once the review settles a version, approved or adjudicated, nothing may change it until routing is done",
  ]) {
    assert.ok(review.includes(rule), rule);
  }
  assert.ok(
    review.indexOf("Post one progress line to the attended thread") <
      review.indexOf("Delegate to the `critic` subagent exactly once"),
    "the progress line precedes the delegation"
  );
  const retryWording = [
    "attempt 1",
    "attempt 2",
    "attempt 3",
    "re-delegate",
    "delegate again",
    "second `CHALLENGE`",
    "fresh reviewer",
    "new critic review",
  ];
  for (const excluded of retryWording) {
    assert.ok(!review.includes(excluded), excluded);
  }
  for (const surface of [
    triageSkill,
    triageReportingReference,
    triageToolsReference,
    handoffSkill,
  ]) {
    for (const excluded of retryWording) {
      assert.ok(!surface.includes(excluded), excluded);
    }
  }
  assert.ok(
    triageSkill.includes(
      "save it once more with its final `**Review**` line (`Approved <the updatedAt the critic echoed> at <commit>`"
    )
  );
  assert.ok(
    triageSkill.includes(
      "`Adjudicated <the adjudicated-evidence updatedAt Stage 5 read back before the settling save> at <commit>: <CHALLENGE | INSUFFICIENT_EVIDENCE | review failure>`"
    )
  );
  assert.ok(
    triageSkill.includes(
      "A document created here for an unreviewed outcome is written once with `**Review**: Not required`"
    )
  );
  assert.ok(triageSkill.includes("are applied in Stage 6 without one"));
  assert.ok(
    triageSkill.includes(
      "Every decision above is provisional until the review below has settled the document"
    )
  );
  assert.ok(
    triageSkill.includes(
      "a hotlane-stopped review never reaches this stage's writes"
    )
  );
  assert.ok(
    triageSkill.includes(
      "A reviewed `Bug` is final once its review has settled, approved or adjudicated; a hotlane-stopped review records nothing. A `Duplicate` is final once its master link is saved"
    )
  );
  assert.ok(
    triageSkill.includes(
      "When Stage 5 review ran, it settled the document version"
    )
  );
  assert.ok(
    triageSkill.includes(
      "do not call `save_investigation_document` before routing, even when adjudication changed the final classification or handling path"
    )
  );
  assert.ok(
    triageSkill.includes(
      "An outcome reclassified during adjudication still entered review and keeps its settled document unchanged"
    )
  );
  assert.ok(triageReportingReference.includes("**Review**: <Pending critic"));
  assert.ok(
    triageReportingReference.includes(
      "Adjudicated <document updatedAt> at <commit>: <CHALLENGE | INSUFFICIENT_EVIDENCE | review failure>"
    )
  );
  assert.ok(
    triageReportingReference.includes(
      "names each blocking finding or the failure reason in the `**Review**` line itself"
    )
  );
  assert.ok(handoffSkill.includes("The critic reviews a ticket exactly once"));
  assert.ok(
    handoffSkill.includes(
      "the `updatedAt` Stage 5 read back after its settling save"
    )
  );
  assert.ok(
    triageToolsReference.includes("## Critic (subagent) and the review skills")
  );
  assert.ok(triageToolsReference.includes("never pass an `outputSchema`"));
  assert.ok(triageToolsReference.includes("exactly once per ticket"));
  for (const excluded of [
    "create_triage_review_packet",
    "read_triage_review_verdict",
    "approvalId",
    "linearProjectId",
  ]) {
    assert.ok(!triageSkill.includes(excluded), excluded);
  }
});
