import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const triageHandlingSkill = readFileSync(
  new URL("../skills/triage-handling/SKILL.md", import.meta.url),
  "utf8"
);
const triageReportingReference = readFileSync(
  new URL("../skills/triage-handling/references/reporting.md", import.meta.url),
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
const extractInstruction = (skill: string, start: string, end: string) => {
  const startIndex = skill.indexOf(start);
  const endIndex = skill.indexOf(end, startIndex);

  assert.ok(startIndex >= 0);
  assert.ok(endIndex > startIndex);
  return skill.slice(startIndex, endIndex);
};

const DESCRIPTION_PATTERN = /^description: "(.*)"$/mu;

test("the engineering hand-off admits an approved feature request", () => {
  const preconditions = extractInstruction(
    handoffSkill,
    "## Preconditions",
    "## Match by cause, not symptom"
  );
  assert.ok(preconditions.includes("`Feature Request` labelled `Approved`"));
  assert.ok(
    preconditions.includes(
      "Never create a master for an unapproved feature request or a closed explanation"
    )
  );
  assert.ok(preconditions.includes("`Engineering Todo` path"));
  assert.ok(preconditions.includes("`Feature Request` type label"));
});

test("the engineering hand-off stops when the master's owner is outside the roster", () => {
  assert.ok(
    handoffSkill.includes(
      "When the tool refuses because the master's owner is not in the owner map, write nothing else"
    )
  );
});

test("a new engineering master carries the Area label and the read-back checks it", () => {
  const create = extractInstruction(
    handoffSkill,
    "## Create one master",
    "## Read back before finishing"
  );
  assert.ok(
    create.includes("the `Area:` label that `route.addLabels` carries")
  );
  const readBack = extractInstruction(
    handoffSkill,
    "## Read back before finishing",
    "Hand back the master id"
  );
  assert.ok(readBack.includes("including the `Area:` label"));
});

test("a master built for an approved feature request carries Feature Request and Approved", () => {
  const create = extractInstruction(
    handoffSkill,
    "## Create one master",
    "## Read back before finishing"
  );
  assert.ok(create.includes("`Feature Request` and `Approved` together"));
  const reuse = extractInstruction(
    handoffSkill,
    "## Reuse an existing master",
    "## Create one master"
  );
  assert.ok(
    reuse.includes(
      "`Feature Request` and `Approved` for an approved feature request"
    )
  );
  assert.ok(
    reuse.includes("`fast-lane` only when the approved route is `HOTLANE`")
  );
});

test("Stage 5 hands decide_triage the ticket's own labels so an approved request is seen", () => {
  const stage = extractInstruction(
    triageHandlingSkill,
    "### Jev decides, Foreman acts",
    "### Fallback: only when `decided: false`"
  );
  assert.ok(stage.includes("the ticket's own labels as `ticketLabels`"));
  const tool = readFileSync(
    new URL("../tools/decide_triage.ts", import.meta.url),
    "utf8"
  );
  const start = tool.indexOf("ticketLabels: z");
  assert.ok(start >= 0, "decide_triage declares ticketLabels");
  const end = tool.indexOf("\n      ),\n", start);
  assert.ok(end > start, "the ticketLabels field closes");
  const field = tool.slice(start, end);
  assert.equal(field.includes(".optional()"), false);
});

test("the not-engineering branch covers an unapproved feature request waiting in Backlog", () => {
  const roster = extractInstruction(
    triageHandlingSkill,
    "### Area-routing roster",
    "### When the ticket is not engineering actionable"
  );
  assert.ok(
    roster.includes(
      "waits in Backlog with `Needs approval` and James until a person adds `Approved` or `Declined`"
    )
  );
  const branch = extractInstruction(
    triageHandlingSkill,
    "### When the ticket is not engineering actionable",
    "### When the root cause warrants action"
  );
  assert.ok(branch.includes("`Backlog/low-impact`"));
  assert.ok(branch.includes("`Feature Request`"));
  assert.equal(branch.includes("unless a lift is wanted"), false);
  assert.equal(branch.includes("closureHeld"), false);
  assert.ok(branch.includes('`grouping: "needs-grouping"`'));
});

test("the unblock never replaces the root cause or the master ticket", () => {
  const unblock = extractInstruction(
    triageHandlingSkill,
    "### Find the unblock",
    "### Jev decides, Foreman acts"
  );
  assert.ok(
    unblock.includes(
      "The unblock never replaces the root cause or the master ticket."
    )
  );
});

test("the investigation document template records the handling path completion reads", () => {
  assert.ok(triageReportingReference.includes("**Handling path**:"));
});

test("the Intercom skill sends a feature request through the report and hand-off branch", () => {
  const opening = intercomTriageSkill.slice(
    intercomTriageSkill.indexOf("Only a confirmed `Bug`"),
    intercomTriageSkill.indexOf("## Boundaries")
  );
  assert.ok(
    opening.includes(
      "Only a confirmed `Bug` or a feature request leaves this skill"
    )
  );
  const handoff = extractInstruction(
    intercomTriageSkill,
    "### A confirmed Bug: create the report, then hand off",
    "## Step 7:"
  );
  assert.ok(
    handoff.includes(
      "a Bug or an approved feature request (`Feature Request` plus `Approved`) then gets documentation, routing and `engineering-handoff`"
    )
  );
  assert.ok(
    handoff.includes(
      "an unapproved one stops at `triage-handling`'s Backlog with `Needs approval` for James"
    )
  );
  const followUp = extractInstruction(
    intercomTriageSkill,
    "## Step 7:",
    "## Step 8:"
  );
  assert.ok(followUp.includes("For User Error, a Platform Limitation,"));
  assert.equal(followUp.includes("nobody wants lifted"), false);
  assert.ok(
    intercomTriageSkill.includes(
      "- `Feature Request`: any ask for a new capability or a lifted limit, however infeasible."
    )
  );
  const record = extractInstruction(
    intercomTriageSkill,
    "## Step 8:",
    "Store only the sanitized pattern"
  );
  assert.ok(
    record.includes(
      "A Bug or feature request is recorded by `triage-handling` Stage 7"
    )
  );
});

test("the Intercom skill keeps historical counts from being reported as today's impact", () => {
  const memory = extractInstruction(
    intercomTriageSkill,
    "## Step 3A: Search investigation memory",
    "## Step 4:"
  );
  assert.ok(
    memory.includes(
      "Historical affected counts are dated figures, never the current blast radius."
    )
  );
});

test("the Intercom skill agrees with triage-handling on the document and the description", () => {
  const documentRule = intercomTriageSkill.slice(
    intercomTriageSkill.indexOf("## Triage investigation document")
  );
  assert.ok(
    documentRule.includes(
      "A Bug's or feature request's document is written by `triage-handling`"
    )
  );
  assert.ok(documentRule.includes("Other outcomes write none."));
  const description = intercomTriageSkill.match(DESCRIPTION_PATTERN)?.[1] ?? "";
  assert.ok(description.includes("confirmed bug or feature request"));
});

test("a correction to a feature request supersedes its case because both use the ticket identifier", () => {
  const record = extractInstruction(
    intercomTriageSkill,
    "## Step 8:",
    "Store only the sanitized pattern"
  );
  assert.ok(
    record.includes(
      "A Bug or feature request is recorded by `triage-handling` Stage 7 under its ticket identifier"
    )
  );
  assert.ok(
    record.includes(
      "For a User Error, a Platform Limitation, or an unproven verdict"
    )
  );
  const correction = extractInstruction(
    intercomTriageSkill,
    "### Corrections from the thread",
    "## Step 9:"
  );
  assert.ok(
    correction.includes(
      "the ticket identifier for a Bug or feature request, `intercom:<conversation id>` otherwise"
    )
  );
  const tools = readFileSync(
    new URL(
      "../skills/intercom-triage-investigate/references/tools.md",
      import.meta.url
    ),
    "utf8"
  );
  assert.ok(
    tools.includes(
      "For a Bug or feature request, `triage-handling` Stage 7 owns the write under the report's ticket identifier"
    )
  );
  assert.ok(
    tools.includes(
      "Step 8 records a User Error, a Platform Limitation, or an unproven claim"
    )
  );
});

test("the Intercom skill never asks the requester for a Linear identifier", () => {
  const boundaries = extractInstruction(
    intercomTriageSkill,
    "## Boundaries",
    "## Step 1:"
  );
  assert.ok(boundaries.includes("Never ask for a Linear identifier."));
});

test("the handling skill follows the returned decision instead of a 0.6 unproven rule (C4)", () => {
  assert.equal(
    triageHandlingSkill.includes(
      "below 0.6 on the classification or path it is `unproven`"
    ),
    false
  );
  assert.ok(
    triageHandlingSkill.includes(
      "Follow the returned decision: `unproven` only when it says so"
    )
  );
});

test("the roster keeps the SAN sandbox exception after the approval decision", () => {
  assert.ok(
    triageHandlingSkill.includes(
      "SAN sandbox tickets go to Aaron Fraga, a feature request once its approval state is settled."
    )
  );
});
