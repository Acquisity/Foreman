import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) =>
  readFileSync(new URL(`../skills/${path}`, import.meta.url), "utf8");

const triageSkill = read("triage/SKILL.md");
const lanes = read("triage/references/lanes.md");
const tools = read("triage/references/tools.md");
const reporting = read("triage/references/reporting.md");
const criticReview = read("triage/references/critic-review.md");
const handoff = read("triage/references/engineering-handoff.md");
const hotlane = read("triage/references/incident-hotlane.md");
const intercomReference = read("triage/references/intercom-source.md");
const billingSkill = read("billing-triage/SKILL.md");

const extractInstruction = (skill: string, start: string, end: string) => {
  const startIndex = skill.indexOf(start);
  const endIndex = skill.indexOf(end, startIndex);

  assert.ok(startIndex >= 0, start);
  assert.ok(endIndex > startIndex, end);
  return skill.slice(startIndex, endIndex);
};

const DESCRIPTION_PATTERN = /^description: "(.*)"$/mu;
const BACKTICK_TOKEN_PATTERN = /`([^`]+)`/gu;
const STAGES = [
  "Stage 1: Establish the case",
  "Stage 2: Resolve customer identity once",
  "Stage 3: Check existing work",
  "Stage 4: Investigate",
  "Stage 5: Decide",
  "Stage 6: Persist and route",
  "Stage 7: Reply and record",
];
const triageFiles = (): string[] => {
  const root = new URL("../skills/triage/", import.meta.url);
  return readdirSync(root, { recursive: true })
    .filter((path): path is string => typeof path === "string")
    .filter((path) => path.endsWith(".md"))
    .map((path) => readFileSync(new URL(path, root), "utf8"));
};

test("triage is one skill with seven ordered stages and no load checkpoint", () => {
  let previous = -1;
  for (const stage of STAGES) {
    const index = triageSkill.indexOf(`## ${stage}`);
    assert.ok(index > previous, stage);
    previous = index;
  }
  assert.equal(triageSkill.match(/^## Stage \d:/gmu)?.length, 7);
  assert.equal(triageSkill.match(/^Completion:/gmu)?.length, 6);
  for (const source of triageFiles()) {
    assert.equal(source.includes("STAGE 4 COMPLETE"), false);
    assert.equal(source.includes("Do not load this reference unless"), false);
    assert.equal(source.includes("triage-handling"), false);
    assert.equal(source.includes("triage-investigate"), false);
  }
  const description = triageSkill.match(DESCRIPTION_PATTERN)?.[1] ?? "";
  assert.ok(description.includes("one Intercom conversation"));
  assert.ok(description.includes("hands money asks to billing-triage"));
});

test("the lane completion check is kept because no code enforces it", () => {
  const completion = extractInstruction(
    triageSkill,
    "## Stage 4: Investigate",
    "## Stage 5: Decide"
  );
  assert.ok(completion.includes("every lane has an entry"));
  assert.ok(completion.includes("Nothing in code checks this"));
  assert.ok(completion.includes("do not call `decide_triage` before it holds"));
  assert.ok(
    completion.includes(
      "without reopening trusted intake, identity, or completed evidence unless new conflicting evidence appears"
    )
  );
});

test("pre-evidence forward references name the decision tool", () => {
  assert.ok(
    triageSkill.includes(
      "`decide_triage` chooses ownership from completed evidence"
    )
  );
  assert.ok(
    triageSkill.includes(
      "a duplicate candidate that `decide_triage` settles in Stage 5"
    )
  );
  assert.ok(triageSkill.includes("runtime's `intakeOnly` value as a fact"));
  assert.ok(triageSkill.includes("including `null`"));
  assert.ok(
    triageSkill.includes(
      "Reopen it only when genuinely new evidence conflicts with that result"
    )
  );
});

test("the classifications and the Bug bar agree with the code", () => {
  for (const line of [
    "- `User Error`: settings, configuration, or anything support can explain, with nothing asked for.",
    "- `Platform Limitation`: expected behavior, or a provider, billing, entitlement or plan limit, with nothing asked for.",
    "- `Feature Request`: any ask for a new capability or a lifted limit, however infeasible.",
  ]) {
    assert.ok(triageSkill.includes(line), line);
  }
  // One Platform Limitation meaning: nothing asked for. An ask is a Feature
  // Request, whatever its feasibility.
  assert.equal(triageSkill.includes("unless a lift is wanted"), false);
  assert.equal(triageSkill.includes("nobody wants lifted"), false);
  // The Bug bar is the four items decide_triage applies; the Intercom report
  // is filed on the first three and the regression check completes it.
  assert.ok(intercomReference.includes("the four-item Bug bar"));
  assert.equal(triageSkill.includes("requires all three"), false);
});

test("nobody is asked for the workspace, and every unknown becomes the reopen condition", () => {
  assert.ok(
    triageSkill.includes(
      "Never ask the requester for a fact: take the most likely reading"
    )
  );
  assert.ok(
    lanes.includes(
      "name the missing workspace or email in the closing reply as what would reopen it, never requesting it"
    )
  );
  for (const source of triageFiles()) {
    assert.equal(source.includes("clarify-with-requester"), false);
    assert.equal(source.includes("ask for the workspace"), false);
  }
  assert.ok(intercomReference.includes("ask for it once and stop"));
});

test("a customer ask never closes unseen and Approved or Declined come only from a person", () => {
  assert.ok(
    triageSkill.includes(
      "A Feature Request waits in Backlog with `Needs approval` and James until a person adds `Approved` or `Declined`; Foreman never adds either."
    )
  );
  assert.ok(
    triageSkill.includes(
      "A repeat joins its master or stays open, related to its match and labelled `Needs grouping`; there is no bare duplicate."
    )
  );
  for (const source of triageFiles()) {
    assert.equal(source.includes("@"), false, "no email addresses");
  }
});

test("triage preserves every evidence lane and the exact tool catalog", () => {
  for (const lane of [
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
  ]) {
    assert.ok(lanes.includes(lane), lane);
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
    "Sentry `search_issues`, then the nested `get_issue_details` read",
    "Prefer a bounded `COUNT` or narrow `SELECT`",
  ]) {
    assert.ok(lanes.includes(laneRule), laneRule);
  }
  assert.ok(
    triageSkill.includes(
      "title, description, attachments, links, comments, labels, priority, project, assignee, requester"
    )
  );

  const toolCatalog: Record<string, string[]> = {
    Autumn: [
      "getCustomer",
      "getPlan",
      "listPlans",
      "listFeatures",
      "getEntity",
      "listEntities",
      "listCustomers",
      "getCurrentOrganization",
    ],
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
    "Billing records": [
      "read_billing_account",
      "read_autumn_billing",
      "read_stripe_billing",
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
    "Jev decisions": [
      "classify_ask",
      "decide_prior_work",
      "decide_triage",
      "decide_billing",
      "check_reply",
    ],
    "Linear connection": [
      "list_issues",
      "get_issue",
      "list_issue_labels",
      "list_projects",
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
      "persons_list",
      "query_session_recordings_list",
      "session_recording_get",
      "read_data_schema",
      "query_trends",
      "query_web_stats",
      "execute_sql",
    ],
    Raindrop: [
      "list_projects",
      "search_events",
      "list_events",
      "get_event",
      "get_trace",
      "get_conversation",
      "list_signals",
      "get_signal",
      "list_issues",
      "get_issue",
      "get_issue_events",
      "search_stumbles",
      "query_cost",
    ],
    Repository: ["prepare_repository", "grep", "glob", "read_file", "bash"],
    Resend: [
      "list_emails",
      "get_email",
      "list_logs",
      "get_log",
      "list_domains",
      "get_domain",
      "list_suppressions",
      "get_suppression",
      "list_contacts",
      "get_contact",
      "list_broadcasts",
      "get_broadcast",
      "list_templates",
      "get_template",
      "list_webhooks",
      "get_webhook",
      "list_segments",
      "get_segment",
      "list_topics",
      "get_topic",
      "list_received_emails",
      "get_received_email",
      "list_received_email_attachments",
      "get_received_email_attachment",
      "list_sent_email_attachments",
      "get_sent_email_attachment",
    ],
    Sentry: [
      "find_organizations",
      "find_projects",
      "search_issues",
      "search_events",
      "search_sentry_tools",
      "execute_sentry_tool",
      "get_issue_details",
      "search_issue_events",
    ],
    Stripe: [
      "stripe_api_read",
      "stripe_api_search",
      "stripe_api_details",
      "search_stripe_documentation",
      "list_available_accounts_or_orgs",
    ],
    Vercel: [
      "getProject",
      "getProjects",
      "getDeployments",
      "getDeployment",
      "getDeploymentEvents",
      "getRuntimeLogs",
    ],
  };
  // Parse each Markdown row and deep-equal the surface, call prefix, and exact
  // ordered token set, so a renamed tool, a wrong call kind, or an extra row
  // or token fails here instead of passing on a substring.
  const parsedRows = tools
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
    ["PlanetScale connection", "Executor: planetscale"],
    ["Billing records", "root, bare"],
    ["Autumn", "Executor: autumn"],
    ["Stripe", "Executor: stripe"],
    ["Instantly", "root, bare"],
    ["Jev decisions", "root, bare"],
    ["Linear searches and routing writes", "root, bare"],
    ["Linear connection", "Executor: linear"],
    ["Inngest runs", "root, bare"],
    ["Inngest connection", "Executor: inngest"],
    ["Sentry", "Executor: sentry"],
    ["Axiom", "Executor: axiom"],
    ["PostHog", "Executor: posthog"],
    ["Lucent", "Executor: lucent"],
    ["Raindrop", "Executor: raindrop"],
    ["Jam", "Executor: jam"],
    ["Vercel", "Executor: foreman_vercel_api"],
    ["Intercom", "Executor: intercom"],
    ["Resend", "Executor: resend"],
    ["Modem", "Executor: modem"],
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
    "never guess paths",
    "this session's Executor discovery instructions",
    "Authored Foreman helpers keep their bare names",
    "constrained by the active Executor toolkit allowlist",
    "Resend currently publishes snake_case names",
    "`truncated`",
    "`oversizedRow`",
    "`envelopeTooLarge`",
    "`raw`",
    "organization `acquisity`, database `acquisity`, branch `main`",
    "8eaf95ab-56ac-4490-8253-f6a96793dc40",
    "no write tool to reach even by accident",
  ]) {
    assert.ok(tools.includes(note), note);
  }
  assert.ok(triageSkill.includes("[references/tools.md](references/tools.md)"));
  assert.ok(triageSkill.includes("[references/lanes.md](references/lanes.md)"));
  assert.equal(triageSkill.includes("| Surface | Call as |"), false);
  assert.ok(
    triageSkill.includes("[references/reporting.md](references/reporting.md)")
  );
  assert.ok(reporting.includes("## Linear report template"));
  assert.ok(reporting.includes("## Triage investigation document template"));
  assert.ok(reporting.includes("## Master ticket template"));
  assert.ok(
    reporting.includes("[engineering-handoff.md](engineering-handoff.md)")
  );
  assert.ok(handoff.includes("## Master ticket template"));
});

test("the catalog keeps the billing reads read-only and in order", () => {
  for (const rule of [
    "## Billing records (read in this order)",
    "takes `billingAccount.id`, never the organization id, which answers `customer_not_found`",
    "A 404 is a wrong id",
    "partner-governed organization, which is on Whop",
    "`has_more: true` means incomplete history",
    "Amounts are in the smallest currency unit (`7200` is $72.00)",
    "`getOrCreateCustomer` creates on a miss, so it is excluded",
    "never invent a `create_refund` tool",
    "`labels` field replaces the whole set",
    "never write those through `save_document`",
  ]) {
    assert.ok(tools.includes(rule), rule);
  }
  assert.ok(
    tools.indexOf("`read_billing_account` takes") <
      tools.indexOf("`read_autumn_billing` takes")
  );
  assert.ok(
    tools.indexOf("`read_autumn_billing` takes") <
      tools.indexOf("`read_stripe_billing`: `customer`")
  );
});

test("triage catalog preserves Instantly authorization failure semantics", () => {
  assert.ok(tools.includes("For either Instantly tool"));
  assert.ok(tools.includes("`available: false`"));
  assert.ok(tools.includes("operator configuration"));
  assert.ok(
    tools.includes("never a reason to ask the requester to sign in or retry")
  );
});

test("Stage 4 mandates loading the catalog before evidence collection", () => {
  const stage = extractInstruction(
    triageSkill,
    "## Stage 4: Investigate",
    "Completion:"
  );
  assert.ok(stage.includes("[references/tools.md](references/tools.md)"));
  assert.ok(stage.includes("before the first evidence lane runs"));
  assert.ok(stage.includes("mandatory"));
  assert.ok(
    stage.includes(
      "do not continue into evidence collection until the catalog is loaded"
    )
  );
  assert.ok(
    stage.indexOf("search investigation memory") <
      stage.indexOf("locate it in the code")
  );
});

test("triage skill stays within the 15000-byte intake budget", () => {
  const bytes = Buffer.byteLength(triageSkill, "utf8");
  assert.ok(
    bytes <= 15_000,
    `triage SKILL.md is ${bytes} bytes, over the 15000-byte budget`
  );
});

test("triage makes retrieval project-independent", () => {
  const establish = extractInstruction(
    triageSkill,
    "## Stage 1: Establish the case",
    "## Stage 2: Resolve customer identity once"
  );
  const memory = extractInstruction(
    lanes,
    "## Search investigation memory",
    "## Read the help center"
  );
  for (const oldInstruction of [
    "A ticket with no project has nothing to search",
    "Unavailable: no Linear project",
    "Pass the project id from the ticket",
    "The project is what picks the product area",
    "route to Aaron Fraga as the triage skill already requires",
  ]) {
    assert.equal(triageSkill.includes(oldInstruction), false, oldInstruction);
    assert.equal(lanes.includes(oldInstruction), false, oldInstruction);
  }
  assert.ok(establish.includes("ordinary intake metadata"));
  assert.ok(
    establish.includes(
      "Do not establish, verify, infer, preserve, or route from a product project yet"
    )
  );
  assert.ok(memory.includes("accepts no Linear project id"));
  assert.ok(memory.includes("every authorized attended triage surface"));
  assert.ok(memory.includes("projectless Linear tickets"));
  assert.ok(memory.includes("tickets that arrive under `Support`"));
  assert.ok(memory.includes("excludes the planned Acquisity Agent area"));
  assert.ok(memory.includes("never added together"));
  assert.ok(
    memory.includes(
      "Historical affected counts are dated figures, never the current blast radius"
    )
  );
  assert.ok(
    lanes.includes(
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
    "puts your overturned conclusion in `ruledOut`",
    "New specifics from the requester reopen a closed ticket",
    "Every close and unproven stop names the fact that would reopen it",
  ]) {
    assert.ok(triageSkill.includes(phrase), phrase);
  }
});

test("ENG-12880 and ENG-13108-shaped intake chooses the project only from evidence", () => {
  const route = extractInstruction(
    triageSkill,
    "## Stage 6: Persist and route",
    "## Stage 7"
  );
  assert.ok(
    route.includes(
      "Pass `route` to the ticket's one `route_ticket` call unchanged"
    )
  );
  assert.ok(route.includes("the evidence-backed project"));
  assert.ok(
    route.includes(
      "A memory analogy, title, incoming `null` or `Support` project never chooses the project"
    )
  );
  assert.ok(route.includes("when `route` has none, name the missing evidence"));
  assert.ok(
    route.includes(
      "When Aaron explicitly asks for read-only validation in a manual test"
    )
  );
  assert.ok(route.includes("apply no Linear mutation and record no memory"));
  assert.ok(route.includes("never a session marker to require or invent"));
  assert.ok(triageSkill.includes("`route_ticket`'s returned `projectId`"));
});

test("triage stops unproven claims before classification or routing", () => {
  const stage = extractInstruction(
    triageSkill,
    "## Stage 5: Decide",
    "## Stage 6"
  );
  const unproven = extractInstruction(
    stage,
    "Unproven:",
    "Jev did not answer:"
  );
  assert.equal(unproven.includes("Aaron Fraga"), false);
  assert.ok(
    unproven.includes("take the unproven branch and stop before classification")
  );
  assert.ok(unproven.includes("Record any safe unblock"));
  assert.ok(
    unproven.includes(
      "preserve state, priority, labels, project, parent, and assignee"
    )
  );
  for (const forbidden of [
    "choose a project",
    "call `route_ticket`",
    "create or attach a master",
    "record investigation memory",
  ]) {
    assert.ok(unproven.includes(forbidden), forbidden);
  }
  assert.ok(reporting.includes("## Unproven branch reporting"));
  assert.ok(reporting.includes("`**Classification**: Not settled`"));
  assert.ok(
    reporting.includes(
      "Never follow `engineering-handoff` or create or attach a master for this branch"
    )
  );
  assert.ok(
    stage.includes("confirm it costs the customer neither data nor money")
  );
});

test("a decided: false answer is unproven and held by Aaron, with no skill fallback", () => {
  const stage = extractInstruction(
    triageSkill,
    "## Stage 5: Decide",
    "## Stage 6"
  );
  assert.ok(
    stage.includes(
      "`decided: false` means Jev did not answer, so nothing is proven"
    )
  );
  const noAnswer = extractInstruction(
    stage,
    "Jev did not answer:",
    "Review before routing:"
  );
  assert.ok(
    noAnswer.includes(
      'call `route_ticket` with only `issue` and `assignee: "Aaron Fraga"`, who holds it'
    )
  );
  assert.ok(
    noAnswer.includes(
      "Under read-only validation, describe that call instead of making it"
    )
  );
  for (const source of triageFiles()) {
    assert.equal(source.includes("fallback decided"), false);
    assert.equal(source.includes("Fallback: only when"), false);
  }
  assert.ok(
    reporting.includes("`**Confidence**: Not available: Jev did not answer`")
  );
  const tool = readFileSync(
    new URL("../tools/decide_triage.ts", import.meta.url),
    "utf8"
  );
  assert.ok(
    tool.includes(
      "decided false means Jev could not answer: the claim is unproven"
    )
  );
  assert.equal(tool.includes("decide by the skill's rules"), false);
});

test("master searches are windowed for Slack intake and Linear sessions, unbounded elsewhere", () => {
  const search = extractInstruction(
    handoff,
    "1. Call `find_related_issues`",
    "\n2. Match eligible candidates"
  );
  assert.ok(search.includes('`scope: "masters"`'));
  assert.ok(
    search.includes("intake-only Slack workflow or a Linear Agent Session")
  );
  assert.ok(search.includes("30 days"));
  assert.ok(search.includes("`createdAfter` is null"));
  assert.ok(search.includes("regardless of creation date"));
  assert.ok(
    search.includes(
      "`route_ticket` refuses a parent created before that cutoff"
    )
  );
  assert.ok(
    search.includes("may be related for history but never reused as the parent")
  );
  assert.ok(
    search.includes(
      "A candidate created exactly at the cutoff is still eligible"
    )
  );
  assert.ok(
    search.includes(
      "Never select an older one as the current master either, even when it surfaces through another issue's relations, investigation memory, an unbounded search, or prior knowledge"
    )
  );
  assert.ok(search.includes("`## Regression seam`"));
  for (const excluded of [
    "linear__list_issues",
    "8eaf95ab",
    "-P30D",
    "hasNextPage",
  ]) {
    assert.ok(!search.includes(excluded), excluded);
  }
  assert.ok(
    handoff.includes(
      "Match eligible candidates on root cause, never on symptom"
    )
  );
});

test("the Intercom source files its report before the shared decision", () => {
  const establish = extractInstruction(
    triageSkill,
    "## Stage 1: Establish the case",
    "## Stage 2"
  );
  assert.ok(
    establish.includes(
      "Source is one Intercom conversation with no Linear issue: load [references/intercom-source.md](references/intercom-source.md) now"
    )
  );
  const intercom = intercomReference;
  for (const phrase of [
    "there is no Linear issue at the start",
    "Never create a placeholder issue and never ask for a Linear identifier",
    "A money ask goes to billing-triage's Intercom source",
    "titled with the claim minus customer identifiers",
    '`labels: ["intercom-sourced", "Customer reported"]`',
    '`links: [{ url: <canonical conversation URL>, title: "Intercom conversation" }]`',
    "Then run Stages 5 to 7 on it",
    "Otherwise do not manufacture engineering work",
    "Record the case under `intercom:<conversation id>` with no project id",
    "`primaryFeatureKey`",
    "`**Intercom source**` and `**Conversation context**`",
  ]) {
    assert.ok(intercom.includes(phrase), phrase);
  }
  const file = intercom.indexOf("File the customer report before Stage 5");
  const decide = intercom.indexOf("Then run Stages 5 to 7 on it");
  assert.ok(file >= 0 && decide > file);
  assert.equal(intercom.split("`save_issue`").length, 3, "both creation sites");
  for (const owned of [
    '`scope: "masters"`',
    "30 days",
    "`inheritAssigneeFrom`",
    "Urgent for outage",
  ]) {
    assert.equal(intercom.includes(owned), false, owned);
  }
});

test("Intercom replies close with a customer-ready block and the bare identifier", () => {
  const intercom = intercomReference;
  for (const phrase of [
    'a short block headed "Reply you can send"',
    "no internal names and no system names",
    "Omit it when the reply asks the requester for missing information",
    'when the requester wrote "do not reply to the customer" or anything equivalent',
    "when the verdict routes to engineering with no customer-facing answer yet",
    "end the reply with that bare identifier alone on the last line",
    "when it created none, say nothing about a ticket",
    "Intercom is read-only: the answer goes to the requester in Slack, never directly to the customer",
    "Leave out assignees, routing, code paths, SQL, raw logs, system names, customer identifiers and memory status",
    "never a URL",
  ]) {
    assert.ok(intercom.includes(phrase), phrase);
  }
});

test("Stage 6 hands the actionable branch to the engineering hand-off", () => {
  const route = extractInstruction(
    triageSkill,
    "## Stage 6: Persist and route",
    "## Stage 7"
  );
  assert.ok(
    route.includes(
      "[references/engineering-handoff.md](references/engineering-handoff.md)"
    )
  );
  assert.ok(
    route.includes("The customer ticket never becomes the engineering ticket")
  );
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
    "in the product project `route.project` carries (never the report's incoming intake project",
  ]) {
    assert.ok(handoff.includes(moved), moved);
  }
  for (const excluded of [
    "reserve_triage_master",
    "complete_triage_master_reservation",
    "read_triage_review_verdict",
    "approvalId",
    "Final communication",
  ]) {
    assert.ok(!handoff.includes(excluded), excluded);
  }
});

test("the hotlane assessment adds the work decide_triage does not return, and never writes", () => {
  for (const kept of [
    "`HOTLANE`",
    "`STANDARD_ENGINEERING`",
    "`NEEDS_HUMAN_URGENT`",
    "`fast-lane`",
    "`confirmed_affected`",
    "`potentially_exposed`",
    "Containment",
    "Customer recovery",
    "Permanent prevention",
    "Observability",
    "`notification_recommendation`",
    "This assessment performs no writes",
    "This assessment does not set priority",
    "For `HOTLANE` and `STANDARD_ENGINEERING`, Foreman includes the assessment in the critic review",
    "`NEEDS_HUMAN_URGENT` instead routes directly to a person before any critic review or settled decision",
    "from `decision.hotlane`",
    "either because a critical lane was unavailable or because a likely hotlane call fell below the confirmation bar",
    "Do not downgrade it to routine work",
  ]) {
    assert.ok(hotlane.includes(kept), kept);
  }
  for (const excluded of [
    "save_issue",
    "save_comment",
    "save_document",
    "Set `HOTLANE`",
    "triage-critic",
    "After approval:",
    "incident channel",
    "decided: false",
  ]) {
    assert.ok(!hotlane.includes(excluded), excluded);
  }
});

test("triage reviews bugs and closures with the critic before routing them", () => {
  const review = extractInstruction(
    triageSkill,
    "Review before routing:",
    "Completion:"
  );
  for (const rule of [
    "`review.required`",
    "[references/critic-review.md](references/critic-review.md)",
    "`route_ticket` refuses a closure or duplicate route until the critic settles",
    "A second objection hands the ticket to Aaron",
    // closureReview holds closures only (triage-log.ts decisionFields), so
    // the skill holds a Bug route until its review settles.
    "nothing in code holds a `Bug`, so route it only after its review settles too",
  ]) {
    assert.ok(review.includes(rule), rule);
  }
  for (const rule of [
    "`**Review**: Pending critic`",
    "Only when `review.kind` is `bug`, read [incident-hotlane.md](incident-hotlane.md)",
    "If the route is `NEEDS_HUMAN_URGENT`, do not call the critic",
    "Post nothing about the review to the attended thread",
    "the next message the thread receives is the final reply",
    "Delegate to the `critic` subagent for the first review",
    "the full 40-character SHA",
    "The critic replies in its fixed JSON shape; pass no schema",
    "this reading starts the adjudication",
    "exactly one entry for each of the twelve criterion slugs with no slug missing or repeated",
    "An `APPROVE` with any `FAIL` criterion, a missing or repeated slug, or a non-empty `blocking_findings` is handled as a `CHALLENGE`",
    "A result with an empty `criteria_results` is a review that could not start",
    "A failed review is not an objection",
    "On `CHALLENGE`, on `INSUFFICIENT_EVIDENCE`, or on a failed review: adjudicate once against the Stage 4 evidence record",
    "take every field it returns, including a changed classification, handling path",
    "read back its adjudicated-evidence `updatedAt`",
    "`**Review**: Adjudicated <that adjudicated-evidence updatedAt> at <commit>: <CHALLENGE | INSUFFICIENT_EVIDENCE | review failure>`",
    "without adding settlement-summary clauses elsewhere in the document",
    "Those clauses occur exactly once, in the `**Review**` line",
    "That final read-back `updatedAt` is the settled version the handoff checks",
    "In a read-only run, describe those writes instead of making them",
    "as the literal marker `read-only`",
    "Do not touch the document",
    "Once the review settles a version, approved or adjudicated, nothing may change it until routing is done",
  ]) {
    assert.ok(criticReview.includes(rule), rule);
  }
  assert.equal(criticReview.includes("Post one progress line"), false);
  for (const excluded of [
    "attempt 1",
    "attempt 2",
    "attempt 3",
    "fresh reviewer",
  ]) {
    assert.ok(!review.includes(excluded), excluded);
    assert.ok(!criticReview.includes(excluded), excluded);
  }
  const persist = extractInstruction(
    triageSkill,
    "## Stage 6: Persist and route",
    "Pass `route`"
  );
  assert.ok(
    persist.includes(
      "When the review ran, the document already exists at the settled version: do not save it again before routing"
    )
  );
  assert.ok(persist.includes("`**Review**: Not required: <review.reason>`"));
  assert.ok(
    persist.includes(
      "After routing reads back, save it once more with its final `**Review**` line"
    )
  );
  assert.ok(reporting.includes("**Review**: <Pending critic"));
  assert.ok(
    reporting.includes(
      "Approved <document updatedAt> at <commit> | Adjudicated <document updatedAt> at <commit>: <CHALLENGE | INSUFFICIENT_EVIDENCE | review failure>"
    )
  );
  assert.ok(
    reporting.includes(
      "names each blocking finding or the failure reason in the `**Review**` line itself"
    )
  );
  assert.ok(
    triageSkill.includes(
      "A reviewed `Bug` is final once its review has settled; a hotlane-stopped or blocked review records nothing; a `Duplicate` is final once its master link is saved"
    )
  );
  assert.ok(
    handoff.includes(
      "The critic reviews a ticket at most twice and Foreman adjudicates once"
    )
  );
  assert.ok(
    handoff.includes(
      "the `updatedAt` Stage 5 read back after its settling save"
    )
  );
  for (const excluded of [
    "create_triage_review_packet",
    "read_triage_review_verdict",
    "approvalId",
    "linearProjectId",
  ]) {
    for (const source of triageFiles()) {
      assert.ok(!source.includes(excluded), excluded);
    }
  }
});

test("ENG-13397-shaped wrong-channel money ask is handled in place", () => {
  // Skills are prompts a model reads, and this repository runs no model, so
  // this proves the skill text instructs it, not that a model followed it.
  for (const skill of [triageSkill, billingSkill]) {
    assert.ok(!skill.includes('state: "Canceled"'));
    assert.ok(!skill.includes("acquisity-refunds-request"));
  }
  const mismatch = extractInstruction(
    triageSkill,
    "Channel mismatched to the ask:",
    "\n\n"
  );
  assert.ok(mismatch.includes("say so in one line"));
  assert.ok(mismatch.includes("continue with the procedure"));
  assert.ok(mismatch.includes("never cancel the ticket"));
  assert.ok(triageSkill.includes("Money ask: load the billing-triage skill."));
  assert.ok(
    billingSkill.includes(
      "handle it where it landed. Say in one line which kind of ask it is, then run the procedure for that kind."
    )
  );
  assert.ok(
    billingSkill.includes(
      "routing sets the project and labels from the evidence, so the channel it arrived in changes nothing"
    )
  );
  const routingIndex = billingSkill.indexOf("## Routing");
  assert.ok(routingIndex >= 0);
  const financialRouting = billingSkill.slice(routingIndex);
  assert.ok(
    financialRouting.includes(
      'Route financial tickets to Support/Financial in one `route_ticket` call: `project: "Support"`'
    )
  );
  assert.ok(financialRouting.includes("money-kind labels as `addLabels`"));
  for (const label of [
    "`Refund`",
    "`Credits`",
    "`Discount`",
    "`intercom-sourced`",
    "`Customer reported`",
    "`Internal reported`",
  ]) {
    assert.ok(financialRouting.includes(label), label);
  }
  assert.ok(!financialRouting.includes("channel"));
});

test("triage carries worked examples for its hardest calls", () => {
  const examples = triageSkill.slice(triageSkill.indexOf("## Examples"));
  assert.equal(examples.match(/^\*\*Input:\*\*/gmu)?.length, 3);
  assert.equal(examples.match(/^\*\*Good output:\*\*/gmu)?.length, 3);
  assert.equal(examples.match(/^\*\*Why:\*\*/gmu)?.length, 3);
  const feature = extractInstruction(
    examples,
    "### A feature ask that repeats a closed one",
    "### A bug that repeats a closed ticket"
  );
  assert.ok(
    feature.includes("`Feature Request`, Backlog, `Needs approval`, James")
  );
  assert.ok(
    feature.includes("adds `Needs grouping`, and the ticket stays open")
  );
  assert.ok(feature.includes("**Not:** `Duplicate` of ENG-15932"));
  const howTo = examples.slice(examples.indexOf("### A how-to that closes"));
  assert.ok(howTo.includes("closes it Canceled with `Needs grouping`"));
});
