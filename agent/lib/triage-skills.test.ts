import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const triageSkill = readFileSync(
  new URL("../skills/triage-investigate/SKILL.md", import.meta.url),
  "utf8"
);
const triageToolCatalog = readFileSync(
  new URL("../skills/triage-investigate/references/tools.md", import.meta.url),
  "utf8"
);
const triageHandlingSkill = readFileSync(
  new URL("../skills/triage-handling/SKILL.md", import.meta.url),
  "utf8"
);
const triageReportingReference = readFileSync(
  new URL("../skills/triage-handling/references/reporting.md", import.meta.url),
  "utf8"
);
const criticReviewReference = readFileSync(
  new URL(
    "../skills/triage-handling/references/critic-review.md",
    import.meta.url
  ),
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
const extractInstruction = (skill: string, start: string, end: string) => {
  const startIndex = skill.indexOf(start);
  const endIndex = skill.indexOf(end, startIndex);

  assert.ok(startIndex >= 0);
  assert.ok(endIndex > startIndex);
  return skill.slice(startIndex, endIndex);
};

const DESCRIPTION_PATTERN = /^description: "(.*)"$/mu;
const BACKTICK_TOKEN_PATTERN = /`([^`]+)`/gu;

test("triage intake hands off to the handling skill after Stage 4", () => {
  assert.ok(triageSkill.includes("## Handoff to handling"));
  assert.ok(
    triageSkill.includes(
      "Stages 5 through 7 and the report templates live in the `triage-handling` skill"
    )
  );
  assert.ok(
    triageSkill.indexOf("## Handoff to handling") >
      triageSkill.indexOf("## Stage 4: Investigate")
  );
  assert.equal(triageSkill.includes("## Stage 5"), false);
  assert.equal(triageSkill.includes("[references/reporting.md]"), false);
  assert.ok(triageHandlingSkill.includes("## Stage 5: Decide handling"));
  assert.ok(
    triageHandlingSkill.includes(
      "Load after triage-investigate Stage 4 completes the evidence record"
    )
  );
  assert.equal(triageHandlingSkill.includes("## Stage 1"), false);
  assert.equal(triageHandlingSkill.includes("## Stage 4"), false);

  const description = triageSkill.match(DESCRIPTION_PATTERN)?.[1] ?? "";
  assert.ok(description.includes("Stages 1 through 4"));
  assert.ok(description.includes("triage-handling"));
  for (const moved of [
    "severity weighting and priority bands",
    "area-routing roster",
    "root-cause masters",
    "unblocking the customer",
  ]) {
    assert.equal(description.includes(moved), false, moved);
  }
});

test("Stage 5 names the Linear state for every handling path", () => {
  assert.ok(
    triageHandlingSkill.includes(
      "`Engineering Todo` is `Todo` (the master owns the work; the report stays open under it), `Duplicate` is `Duplicate`, `Backlog/low-impact` is `Backlog`, `Support/Financial` and `Support/Product follow-up` are `Todo` (a person still acts), and `Resolved by triage`, `User Error`, and `Platform Limitation` are `Done`."
    )
  );
});

test("shared triage exposes one seven-stage workflow across intake and handling", () => {
  const intakeStages = [
    "Stage 1: Establish the case",
    "Stage 2: Resolve customer identity once",
    "Stage 3: Check existing work and frame the investigation",
    "Stage 4: Investigate",
  ];
  const handlingStages = [
    "Stage 5: Decide handling",
    "Stage 6: Persist and route",
    "Stage 7: Finish the attended response and memory bookkeeping",
  ];

  let previousIndex = -1;
  for (const stage of intakeStages) {
    const stageIndex = triageSkill.indexOf(`## ${stage}`);
    assert.ok(stageIndex > previousIndex);
    previousIndex = stageIndex;
  }
  previousIndex = -1;
  for (const stage of handlingStages) {
    const stageIndex = triageHandlingSkill.indexOf(`## ${stage}`);
    assert.ok(stageIndex > previousIndex);
    previousIndex = stageIndex;
  }

  assert.equal(triageSkill.match(/^## Stage \d:/gmu)?.length, 4);
  assert.equal(triageSkill.match(/^Purpose:/gmu)?.length, 4);
  assert.equal(triageSkill.match(/^Inputs:/gmu)?.length, 4);
  assert.equal(triageSkill.match(/^Completion:/gmu)?.length, 4);
  assert.equal(triageHandlingSkill.match(/^## Stage \d:/gmu)?.length, 3);
  assert.equal(triageHandlingSkill.match(/^Purpose:/gmu)?.length, 3);
  assert.equal(triageHandlingSkill.match(/^Inputs:/gmu)?.length, 3);
  assert.equal(triageHandlingSkill.match(/^Completion:/gmu)?.length, 3);
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
  // The full exact-name catalog, pinned against the reference booklet table so
  // a dropped row or renamed tool fails here. Keys are the table's Surface
  // labels.
  const toolCatalog: Record<string, string[]> = {
    Axiom: [
      "queryDataset",
      "listDatasets",
      "getDatasetFields",
      "queryMetrics",
      "listMetrics",
      "searchMetrics",
      "listMetricTags",
      "getMetricTagValues",
      "checkMonitors",
      "getMonitorHistory",
      "getSavedQueries",
      "listDashboards",
      "getDashboard",
      "exportDashboard",
      "listNotifiers",
    ],
    "Customer identity": ["lookup_customer"],
    "Help center": ["find_help_article"],
    "Inngest connection": [
      "list_function_runs",
      "list_runs",
      "get_run",
      "get_run_trace",
      "get_event_runs",
      "list_functions",
      "get_function",
      "list_envs",
      "query_insights",
      "list_insights_tables",
      "list_insights_event_schemas",
      "get_app",
      "get_apps",
      "list_webhooks",
      "health",
    ],
    "Inngest runs": ["find_function_runs"],
    Instantly: ["list_instantly_subworkspaces", "read_instantly_subworkspace"],
    Intercom: [
      "search",
      "fetch",
      "search_conversations",
      "get_conversation",
      "search_contacts",
      "get_contact",
      "get_company",
      "list_companies",
    ],
    "Investigation memory": [
      "search_investigation_memory",
      "record_investigation_case",
      "correct_investigation_case",
    ],
    Jam: [
      "search",
      "fetch",
      "listJams",
      "getDetails",
      "getMetadata",
      "getConsoleLogs",
      "getNetworkRequests",
      "getUserEvents",
      "getScreenshots",
      "getFrames",
      "getVideoTranscript",
      "analyzeVideo",
      "getRecordingLink",
      "getRecordingUrlVerifyLink",
      "listRecordingLinks",
      "listRecordingLinkJams",
      "listRecordingUrls",
      "listFolders",
      "listMembers",
    ],
    "Linear connection": [
      "list_issues",
      "get_issue",
      "list_issue_labels",
      "save_issue",
      "save_document",
      "list_comments",
      "save_comment",
    ],
    "Linear searches and routing writes": [
      "find_related_issues",
      "route_ticket",
      "save_investigation_document",
    ],
    Lucent: ["list_issues", "get_issue", "list_insights"],
    Modem: ["search_modem"],
    "PlanetScale connection": [
      "planetscale_list_organizations",
      "planetscale_get_organization",
      "planetscale_list_databases",
      "planetscale_get_database",
      "planetscale_list_branches",
      "planetscale_get_branch",
      "planetscale_get_insights",
      "planetscale_list_schema_recommendations",
      "planetscale_search_documentation",
    ],
    "PlanetScale data": ["planetscale_execute_read_query", "describe_table"],
    PostHog: [
      "exec",
      "persons",
      "session-recording",
      "error-tracking",
      "query",
      "execute-sql",
      "insight",
      "event-definition",
      "heatmaps",
    ],
    Repository: ["prepare_repository", "grep", "glob", "read_file", "bash"],
    Resend: [
      "list-emails",
      "get-email",
      "list-logs",
      "get-log",
      "list-domains",
      "get-domain",
      "list-suppressions",
      "get-suppression",
      "list-contacts",
      "get-contact",
      "list-broadcasts",
      "get-broadcast",
      "list-templates",
      "get-template",
      "list-webhooks",
      "get-webhook",
      "list-segments",
      "get-segment",
      "list-topics",
      "get-topic",
      "list-received-emails",
      "get-received-email",
      "list-received-email-attachments",
      "get-received-email-attachment",
      "list-sent-email-attachments",
      "get-sent-email-attachment",
    ],
    Sentry: [
      "find_organizations",
      "find_projects",
      "find_issues",
      "search_issues",
      "get_issue_details",
      "search_events",
      "search_issue_events",
    ],
    Vercel: [
      "get_runtime_errors",
      "get_runtime_logs",
      "list_deployments",
      "get_deployment",
      "get_deployment_build_logs",
      "list_projects",
      "get_project",
      "list_teams",
      "get_web_analytics",
      "search_vercel_documentation",
      "web_fetch_vercel_url",
      "get_access_to_vercel_url",
      "list_agent_runs",
      "get_agent_run",
      "get_agent_run_trace",
      "list_agent_run_projects",
      "list_toolbar_threads",
      "get_toolbar_thread",
    ],
  };

  for (const lane of evidenceLanes) {
    assert.ok(triageSkill.includes(lane), lane);
  }
  for (const laneRule of [
    "follows Workspace Group pages up to a 100-page safety cap",
    "returns only accepted subworkspaces",
    "never a complete list",
    "must resolve exactly once",
    "fail closed",
    "accepts a URL",
    "`get_contact` returns the profile only and is not a step on this path",
    "strip the prefix or the filter matches nothing",
    "filters structured fields and has no free-text",
    "title, description, attachments, links, comments, labels, priority, project, assignee, requester",
    "`search_issues` only when that finds nothing",
    "Prefer a bounded `COUNT` or narrow `SELECT`",
  ]) {
    assert.ok(triageSkill.includes(laneRule), laneRule);
  }

  // Parse each Markdown row of the reference booklet and deep-equal the
  // surface, call prefix, and exact ordered token set, so a renamed tool, a
  // wrong call kind, or an extra row or token fails here instead of passing
  // on a substring.
  const parsedRows = triageToolCatalog
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("| ") &&
        !line.startsWith("| Surface") &&
        !line.startsWith("| ---")
    )
    .map((line) => {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      const [surface = "", callAs = "", namesCell = ""] = cells;
      return {
        callAs: callAs.replaceAll("`", ""),
        names: [...namesCell.matchAll(BACKTICK_TOKEN_PATTERN)].map(
          (match) => match[1]
        ),
        surface,
      };
    });
  const expectedShape: Array<readonly [string, string]> = [
    ["Repository", "root, bare"],
    ["Help center", "root, bare"],
    ["Investigation memory", "root, bare"],
    ["Customer identity", "root, bare"],
    ["PlanetScale data", "root, bare"],
    ["PlanetScale connection", "planetscale__"],
    ["Instantly", "root, bare"],
    ["Linear searches and routing writes", "root, bare"],
    ["Linear connection", "linear__"],
    ["Inngest runs", "root, bare"],
    ["Inngest connection", "inngest__"],
    ["Sentry", "sentry__"],
    ["Axiom", "axiom__"],
    ["PostHog", "posthog__"],
    ["Lucent", "lucent__"],
    ["Jam", "jam__"],
    ["Vercel", "vercel__"],
    ["Intercom", "intercom__"],
    ["Resend", "resend__"],
    ["Modem", "modem__"],
  ];
  assert.deepEqual(
    parsedRows,
    expectedShape.map(([surface, callAs]) => ({
      callAs,
      names: toolCatalog[surface],
      surface,
    }))
  );
  for (const note of [
    "Never invent a tool name from a service's REST API or CLI",
    "with the `connection` argument naming one connection",
    "never as `planetscale__planetscale_execute_read_query`",
    "no allowlist",
    "kebab-case",
    "`truncated`",
    "`oversizedRow`",
    "`envelopeTooLarge`",
    "`raw`",
    "organization `acquisity`, database `acquisity`, branch `main`",
    "8eaf95ab-56ac-4490-8253-f6a96793dc40",
    "no write tool to reach even by accident",
  ]) {
    assert.ok(triageToolCatalog.includes(note), note);
  }
  // The catalog moved out of the intake skill into the reference booklet;
  // the skill links it and carries no inline table.
  assert.ok(triageSkill.includes("[references/tools.md](references/tools.md)"));
  assert.equal(triageSkill.includes("| Surface | Call as |"), false);
  assert.equal(
    triageSkill.includes("Exact tool names, one row per surface"),
    false
  );
  assert.ok(
    triageHandlingSkill.includes(
      "[references/reporting.md](references/reporting.md)"
    )
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

test("triage intake mandates loading the tool catalog before evidence collection", () => {
  const stage4Index = triageSkill.indexOf("## Stage 4: Investigate");
  const gateIndex = triageSkill.indexOf("### Load the tool catalog first");
  const firstLaneIndex = triageSkill.indexOf("### Search investigation memory");

  assert.ok(stage4Index >= 0);
  assert.ok(gateIndex > stage4Index);
  assert.ok(firstLaneIndex > gateIndex);

  const gate = extractInstruction(
    triageSkill,
    "### Load the tool catalog first",
    "### Search investigation memory"
  );
  assert.ok(gate.includes("[references/tools.md](references/tools.md)"));
  assert.ok(gate.includes("before the first evidence lane runs"));
  assert.ok(gate.includes("mandatory"));
  assert.ok(
    gate.includes(
      "do not continue into evidence collection until the catalog is loaded"
    )
  );
});

test("triage intake skill stays within its 15000-byte budget", () => {
  const intakeBytes = Buffer.byteLength(triageSkill, "utf8");
  assert.ok(
    intakeBytes <= 15_000,
    `triage-investigate SKILL.md is ${intakeBytes} bytes, over the 15000-byte budget`
  );
});

test("triage handling skill stays within its 20000-byte budget", () => {
  const handlingBytes = Buffer.byteLength(triageHandlingSkill, "utf8");
  assert.ok(
    handlingBytes <= 20_000,
    `triage-handling SKILL.md is ${handlingBytes} bytes, over the 20000-byte budget`
  );
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
    assert.equal(
      triageHandlingSkill.includes(oldInstruction),
      false,
      oldInstruction
    );
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
    triageHandlingSkill.includes(
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
    assert.ok(triageHandlingSkill.includes(phrase), phrase);
  }
});

test("ENG-12880-shaped projectless intake searches memory before choosing a project", () => {
  const memorySearch = triageSkill.indexOf(
    "including projectless Linear tickets"
  );
  const handoff = triageSkill.indexOf("## Handoff to handling");
  const projectChoice = triageHandlingSkill.indexOf(
    "### Choose the product project from completed evidence"
  );

  assert.ok(memorySearch >= 0);
  assert.ok(handoff > memorySearch);
  assert.ok(projectChoice >= 0);
  assert.ok(
    triageHandlingSkill.includes(
      "Pass the evidence-backed project to the ticket's one `route_ticket` call"
    )
  );
  assert.ok(
    triageHandlingSkill.includes(
      "pass that resulting project id to `record_investigation_case`"
    )
  );
});

test("ENG-13108-shaped Support intake neither gates memory nor triggers fallback", () => {
  assert.ok(
    triageHandlingSkill.includes(
      "incoming `Support` project cannot make this decision"
    )
  );
  assert.ok(
    triageHandlingSkill.includes(
      "Missing or unmapped intake metadata by itself is never that evidence gap and never triggers Aaron routing"
    )
  );
  assert.ok(
    triageHandlingSkill.includes(
      "When Aaron explicitly requests read-only validation during an attended manual test"
    )
  );
  assert.ok(
    triageHandlingSkill.includes(
      "apply no Linear mutation and do not record investigation memory"
    )
  );
  assert.ok(
    triageHandlingSkill.includes(
      "This is an operator instruction for that test, not a runtime authorization mode"
    )
  );
  assert.ok(
    triageHandlingSkill.includes(
      "Do not require or invent a session marker for it"
    )
  );
});

test("shared triage stops unproven claims before classification or routing", () => {
  assert.ok(
    triageHandlingSkill.includes(
      "When the deciding confirmation is still missing, take the unproven branch and stop before classification"
    )
  );
  assert.ok(
    triageHandlingSkill.includes(
      "Preserve the source ticket's current state, priority, and labels"
    )
  );
  assert.ok(
    triageHandlingSkill.includes(
      "Do not create or attach a master, route engineering work, or record investigation memory"
    )
  );
  assert.ok(
    triageHandlingSkill.includes(
      "Before stopping, record any safe unblock supported by the completed evidence"
    )
  );
  assert.ok(
    triageHandlingSkill.includes(
      "action, owner, current status, and confirmation that it costs the customer neither data nor money"
    )
  );
  assert.ok(
    triageHandlingSkill.includes(
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

test("triage Stage 6 hands the actionable branch to engineering-handoff", () => {
  const branch = extractInstruction(
    triageHandlingSkill,
    "### When the root cause warrants action",
    "### Area-routing roster"
  );
  assert.ok(branch.includes("Load `engineering-handoff`"));
  assert.ok(!branch.includes("linear__list_issues"));
  assert.ok(!triageSkill.includes("## Master ticket template"));
  assert.ok(!triageHandlingSkill.includes("## Master ticket template"));
  for (const moved of [
    "## Preconditions",
    "## Match by cause, not symptom",
    "## Search for the current master",
    "## Reuse an existing master",
    "## Create one master",
    "## Read back before finishing",
    "One master per root cause",
    "`fast-lane`",
    "area-routing roster in `triage-handling` Stage 6",
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
});

test("triage reviews a Bug with the critic before routing it", () => {
  const review = extractInstruction(
    triageHandlingSkill,
    "### Review a Bug before routing it",
    "## Stage 6: Persist and route"
  );
  for (const rule of [
    "This review runs only when the classification is `Bug` and the handling path is not `Duplicate`",
    "a duplicate routes nothing new to engineering",
    "The critic runs exactly once per ticket",
    "Foreman posts one progress line, delegates once, and adjudicates the result once",
    "never parks the ticket on a person",
    "Foreman settles the findings against the Stage 4 evidence record and continues routing",
    "[references/critic-review.md](references/critic-review.md)",
  ]) {
    assert.ok(review.includes(rule), rule);
  }
  for (const rule of [
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
    "set its `**Review**` line to `Adjudicated: <CHALLENGE | INSUFFICIENT_EVIDENCE | review failure> at <commit>`",
    "followed by one short clause per blocking finding or the failure reason, each naming what settled it",
    "That read-back `updatedAt` is the settled version the handoff checks",
    "In a read-only run, describe those writes instead of making them",
    "as the literal marker `read-only`",
    "Do not touch the document",
    "Once the review settles a version, approved or adjudicated, nothing may change it until routing is done",
  ]) {
    assert.ok(criticReviewReference.includes(rule), rule);
  }
  assert.ok(
    criticReviewReference.indexOf(
      "Post one progress line to the attended thread"
    ) <
      criticReviewReference.indexOf(
        "Delegate to the `critic` subagent exactly once"
      ),
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
    assert.ok(!criticReviewReference.includes(excluded), excluded);
  }
  for (const surface of [
    triageSkill,
    triageHandlingSkill,
    triageReportingReference,
    criticReviewReference,
    handoffSkill,
  ]) {
    for (const excluded of retryWording) {
      assert.ok(!surface.includes(excluded), excluded);
    }
  }
  assert.ok(
    triageHandlingSkill.includes(
      "save it once more with its final `**Review**` line (`Approved <the updatedAt the critic echoed> at <commit>`"
    )
  );
  assert.ok(
    triageHandlingSkill.includes(
      "`Adjudicated <the updatedAt Stage 5 read back> at <commit>: <CHALLENGE | INSUFFICIENT_EVIDENCE | review failure>`"
    )
  );
  assert.ok(
    triageHandlingSkill.includes(
      "A document created here for an unreviewed outcome is written once with `**Review**: Not required`"
    )
  );
  assert.ok(triageHandlingSkill.includes("are applied in Stage 6 without one"));
  assert.ok(
    triageHandlingSkill.includes(
      "Every decision above is provisional until the review below has settled the document"
    )
  );
  assert.ok(
    triageHandlingSkill.includes(
      "a hotlane-stopped review never reaches this stage's writes"
    )
  );
  assert.ok(
    triageHandlingSkill.includes(
      "A reviewed `Bug` is final once its review has settled, approved or adjudicated; a hotlane-stopped review records nothing. A `Duplicate` is final once its master link is saved"
    )
  );
  assert.ok(
    triageHandlingSkill.includes(
      "For a `Bug` other than a `Duplicate`, the review in Stage 5 settled the document version"
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
  for (const excluded of [
    "create_triage_review_packet",
    "read_triage_review_verdict",
    "approvalId",
    "linearProjectId",
  ]) {
    assert.ok(!triageSkill.includes(excluded), excluded);
    assert.ok(!triageHandlingSkill.includes(excluded), excluded);
    assert.ok(!criticReviewReference.includes(excluded), excluded);
  }
});
