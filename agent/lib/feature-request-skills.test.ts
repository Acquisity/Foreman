import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const triageSkill = readFileSync(
  new URL("../skills/triage/SKILL.md", import.meta.url),
  "utf8"
);
const triageReportingReference = readFileSync(
  new URL("../skills/triage/references/reporting.md", import.meta.url),
  "utf8"
);
const handoffSkill = readFileSync(
  new URL(
    "../skills/triage/references/engineering-handoff.md",
    import.meta.url
  ),
  "utf8"
);
const extractInstruction = (skill: string, start: string, end: string) => {
  const startIndex = skill.indexOf(start);
  const endIndex = skill.indexOf(end, startIndex);

  assert.ok(startIndex >= 0);
  assert.ok(endIndex > startIndex);
  return skill.slice(startIndex, endIndex);
};

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
    triageSkill,
    "Call `decide_triage` with",
    "Unproven:"
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
  assert.ok(
    triageSkill.includes(
      "waits in Backlog with `Needs approval` and James until a person adds `Approved` or `Declined`"
    )
  );
  const branch = extractInstruction(
    triageSkill,
    "- Not engineering actionable",
    "- A `Bug` on `Engineering Todo`"
  );
  assert.ok(branch.includes("`Backlog/low-impact`"));
  assert.ok(branch.includes("`Feature Request`"));
  assert.equal(branch.includes("unless a lift is wanted"), false);
  assert.equal(branch.includes("closureHeld"), false);
  assert.ok(branch.includes('`grouping: "needs-grouping"`'));
});

test("the unblock never replaces the root cause or the master ticket", () => {
  const unblock = extractInstruction(
    triageSkill,
    "Find the unblock:",
    "Call `decide_triage` with"
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

test("an Intercom feature request is filed and runs the shared decision", () => {
  const intercom = extractInstruction(
    triageSkill,
    "## Intercom source",
    "## Examples"
  );
  assert.ok(
    intercom.includes(
      "File the customer report before Stage 5 when the evidence shows a `Bug`"
    )
  );
  assert.ok(intercom.includes("or a `Feature Request`"));
  assert.ok(intercom.includes("Then run Stages 5 to 7 on it"));
  assert.ok(
    triageSkill.includes(
      "- A `Bug` on `Engineering Todo`, or a `Feature Request` labelled `Approved`: follow [references/engineering-handoff.md]"
    )
  );
  assert.ok(
    triageSkill.includes(
      "- `Feature Request`: any ask for a new capability or a lifted limit, however infeasible."
    )
  );
});

test("a correction to a feature request supersedes its case because both use the source id", () => {
  assert.ok(
    triageSkill.includes(
      "its `sourceIssueId` (the ticket identifier, or `intercom:<conversation id>` for a ticketless Intercom case)"
    )
  );
  assert.ok(
    triageSkill.includes(
      "Never create a placeholder issue and never ask for a Linear identifier."
    )
  );
});

test("the handling skill follows the returned decision instead of a 0.6 unproven rule (C4)", () => {
  assert.equal(
    triageSkill.includes(
      "below 0.6 on the classification or path it is `unproven`"
    ),
    false
  );
  assert.ok(
    triageSkill.includes(
      "Follow the returned decision: `unproven` only when it says so"
    )
  );
});
