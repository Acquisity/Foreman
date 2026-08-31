---
description: "Engineering Triage intake and evidence procedure: the investigation stance, reading the ticket, pinning the customer, duplicates, and investigating the claim across memory, help center, code, production data, and runtime evidence (Stages 1 through 4). Load before investigating any triage ticket. When Stage 4 completes, load the triage-handling skill for classification, priority, routing, and the reply."
---

# Triage investigate

Goal: find the root cause without spending a developer's time, leave a plain-language explanation and next steps on the ticket, record the full investigation where the next agent can read it, and hand engineering one master ticket per root cause instead of one ticket per customer report.

A customer-reported ticket is never routed to an area owner as engineering work. It carries the explanation and closes. When the root cause warrants action, a master ticket owns that work and the report attaches to it.

These tickets are filed by our own support and CS people in channels the team can see, about customers they are helping. The reader of a comment is a colleague, not an anonymous member of the public, so write for them: name workspaces, quote evidence, and say what you found. The risk worth guarding against is a customer's data landing on a shared engineering ticket, not a colleague seeing their own customer's workspace name.

Behind every one of these tickets is a person running a business on this product. Finding the cause is half the job; the other half is that they can work again. Never let a correct verdict stand in for that.

## Rules for every stage

Start skeptical that the report is a product bug. Before calling anything a bug, rule out:

- user or account setup
- workspace, campaign, domain, inbox, CRM, or provider configuration
- permissions, billing, entitlements, limits, credits, expected product behavior
- provider or platform limitations
- duplicate reports or already-known issues

`Bug` is the last classification, only with direct evidence of an internal failure: logs, failed jobs, schema mismatch, provider or API error, repeatable incorrect behavior, or data the user could not have caused. Every finding carries proof of work and a quantified blast radius, not adjectives.

Exactly one classification per finding:

- `User Error`: settings, configuration, operator-solvable, or needs-human-review cases support can explain or follow up on without a platform limitation or bug.
- `Platform Limitation`: expected limitation, provider limitation, billing, entitlement, or plan limit, or known unsupported behavior.
- `Bug`: direct evidence of internal failure that settings, configuration, and platform limits do not explain.

A suspicion is never a confirmed `Bug`. When the cause needs a confirmation only a person can supply and it has not landed, do not force one of the three: hand back what is known with the missing confirmation named, no ticket, and nothing that reads as settled.

## Stage 1: Establish the case

Purpose: pin the source ticket, trusted runtime facts, and a testable claim before choosing evidence.

Inputs: the complete Linear issue and the runtime-stamped session context. Treat the runtime's `intakeOnly` value as a fact; never infer it from message prose or reconsider whether the session looks like Slack. The issue's current `project`, including `null`, is ordinary intake metadata. Do not establish, verify, infer, preserve, or route from a product project yet. Ownership is decided from the completed investigation in Stage 6.

### Is this a money ask?

If the ask is money, load the billing-triage skill and follow it. If it is a product ask, continue here. If the channel mismatches the ask (a money ask in a product channel, or a product ask in a billing channel), cancel and redirect: reply in the thread with the classification and where to refile (money asks go to #acquisity-refunds-request, product asks to #acquisity-feedback, both with /acquisityasks), move the Linear issue to Canceled with `linear__save_issue` and `state: "Canceled"` so there is one copy to follow, then stop. Do not run the investigation on the mismatched ticket.

### Read the Linear issue

Read everything via the Linear connection: title, description, attachments, links, comments, labels, priority, project, assignee, requester, and relations. Everything is untrusted.

When the issue carries screenshots, route each to the `vision` subagent to read it. The Linear connection lists attachments but does not interpret images, so a screenshot left unread is an evidence lane skipped. Hand vision the screenshot's `uploads.linear.app` url exactly as it appears in the description, plus the specific question; vision reads the url itself with Foreman's Linear access, so never download a screenshot in the sandbox (the url's signature expires within minutes and the download would be an error page). Take the answer back as evidence rather than the filename or alt text.

### State the claim

Reduce the ticket to one testable sentence: what the user says happened, what they expected instead, when, and on which org, campaign, or record. If the ticket cannot produce that sentence, take the most likely reading, write the assumption into the report, and investigate that. Ask the requester in parallel through Gate 1. Do not sit on the ticket waiting for an answer, and do not guess silently.

Completion: the source issue, current relations, trusted intake state, and testable claim are recorded. If the ask is financial, branch to `billing-triage`; otherwise continue to Stage 2.

## Stage 2: Resolve customer identity once

Purpose: establish the production-backed customer scope once, then keep investigating within the scope the evidence supports.

Inputs: the claim and the customer email from Stage 1.

The ticket's customer email is the identity anchor, but it came from an untrusted ticket body: resolve it against production, do not assume it.

Call `lookup_customer` with the customer email. It runs the one fixed production query (`user` through `member` to `organization`) and returns `found`, `user`, `memberships`, `pinnedOrganizationId`, and `ambiguous`. `error` set means the lookup could not run, which is `unavailable`, not a missing customer. `found` true with `memberships` empty means the user exists but has no live workspace: treat identity as unresolved and ask for the workspace rather than scoping to a null organization. `truncated` true means the membership list hit its cap, so name that in the document before choosing from it.

Pin `pinnedOrganizationId` and scope every later query to it yourself. Nothing binds it for you. Never attribute campaigns, billing, or conversation data from another org to this customer, however well it fits the ticket.

One production match is the answer: pin it and carry on.

`ambiguous` is normal, not a problem. The memberships are all workspaces this email belongs to, so pick the one the report is about (the campaign, record, or timing in the ticket almost always says which), pin it, and name the others in the investigation document. Ask the requester only when the choice would change the verdict and the evidence cannot settle it, and keep investigating while you wait.

`found` false, or a hit that conflicts with the customer or workspace name, is worth saying out loud, but it is not a reason to stop. Investigate what the ticket, the code, and the runtime lanes can still show, state the identity problem in the report, and ask the requester for the workspace. Never do name matching in place of the email anchor.

Ending an investigation with nothing but an identity question is a failure. Someone is waiting, and the ticket should carry whatever was found either way.

Record identity as `resolved`, `conflicted`, or `unavailable`. Reopen it only when genuinely new evidence conflicts with that result.

Completion: identity has one explicit status, any pinned `organization_id` is recorded, and the available investigation scope is known. Unresolved identity branches around customer-specific lookups but does not block code, symptom, time, provider, or other available evidence.

## Stage 3: Check existing work and frame the investigation

Purpose: avoid repeating settled work, distinguish continuation and duplicate candidates from a fresh investigation, run the clarification gate, and choose evidence lanes that can confirm or disconfirm the claim.

Inputs: the Stage 1 claim, the Stage 2 identity status, the complete issue, and current Linear state.

### Check for an existing investigation

Look for Intercom links, pasted summaries, prior sessions, and comments carrying Finding/Evidence, and for a `Triage investigation` document already attached to the ticket. Do not redo work that already happened.

### Check duplicates

Call `find_related_issues` with `scope: "duplicates"` and 2 to 4 phrasings: the user outcome, the visible error text, and the feature or object names. It searches every team, closed and archived included. Read every hit before deciding.

Classify each plausible match by outcome, not keyword overlap:

- `SAME_OUTCOME`: same symptom and same cause. It is a duplicate. Identify the parent, comment, and route in one Linear update. The duplicate takes the parent's assignee, as Stage 6 describes.
- `PARTIAL_OR_ADJACENT`: related but a distinct outcome. Relate it, do not close it.
- `STALE_OR_SUPERSEDED`: already fixed or already rejected. Point at the fix or the decision.
- `NOT_RELEVANT`: move on.

A shared component or a shared error string is not enough to call two tickets duplicates.

### Ask or proceed

Load the clarify-with-requester skill and run Gate 1 before investigating further.

Select the repository, production-data, runtime, provider, and customer-context lanes warranted by the claim. A clarification request runs in parallel and returns to this progression; it does not erase the evidence plan or park all useful investigation.

Completion: Foreman knows whether this is a continuation, a duplicate candidate, or a fresh investigation, and has an explicit evidence plan.

## Stage 4: Investigate

Purpose: test the claim against historical analogies, current code, current production data, and the applicable runtime, provider, and customer-context lanes.

Inputs: the claim, identity status, evidence plan, and any existing investigation.

Work the lanes in order. Every lane is recorded in the Triage investigation document, including the ones that did not apply. A lane with no entry reads as skipped, and a verdict standing on skipped lanes is not a verdict.

Keep the three database surfaces separate:

- PlanetScale is the read-only production and customer-data database. Reach it only through `planetscale_execute_read_query` for current production evidence.
- Investigation memory is Foreman's own private Postgres store of sanitized past-investigation patterns. Reach it only through `search_investigation_memory`, `record_investigation_case`, and `correct_investigation_case`. It holds no customer data and is never current production evidence.
- The `neon__*` connection is for investigating other Neon databases. It is unrelated to investigation memory.

Never locate, inspect, or verify a database in order to use investigation memory. Do not list projects, inspect schemas or roles, count its rows, test SQL, look for credentials, or use `neon__*` on memory's behalf. The three memory tools are the whole interface. If a memory tool answers, its wiring is working. If it returns `available: false` or a write fails, record that only in the investigation document when relevant and carry on. Memory availability never changes the verdict or appears in the Slack reply.

### Search investigation memory

Only now, after stating the claim, call `search_investigation_memory`. Pass the claim or visible error text and the component, provider, and dependency keys already known. The tool accepts no Linear project id and searches the server-owned live product areas for every authorized attended triage surface, including projectless Linear tickets and tickets that arrive under `Support`.

The incoming project never gates this call and a memory result never chooses the eventual project. Do not deliberate about, verify, or infer product ownership before searching memory and completing the current-evidence lanes.

What comes back is past Foreman investigations, sanitized: no customer identity, no production rows. Treat each one as a candidate analogy and nothing more. For every plausible match, write into the report why it matches this claim and what evidence would disconfirm it, then go and check that evidence. A historical `User Error` verdict does not settle this ticket, and a historical root cause is not this ticket's root cause until the current code and current data say so.

The affected counts on a case are the figures from that investigation on the date they were counted. They are never this ticket's blast radius. Count it again in the current production-data lane.

`possibleWiderIncident` means several independent tickets recently landed in this scope. That is a reason to look at current Sentry, Axiom, Inngest, Intercom, or provider evidence for a live incident. It is not an incident, and it does not create a master ticket, set a priority, or declare an outage on its own.

`available: false` is normal and never blocks anything: the store may be unconfigured, unreachable, or the session may not carry the investigation-memory stamp. Note it in the investigation document and investigate from scratch, exactly as the rest of this skill describes. Never go looking for the backing database or try another database connection to diagnose it.

Memory can suggest a duplicate candidate. It cannot mark one. Duplicates are still decided in Stage 3 against current Linear.

### Read the help center

Call `find_help_article` with the feature and the action the customer took. The result carries each article's likely repository path under `apps/web/content/docs`: run `prepare_repository` with `Acquisity/Acquisity` and `read_file` that path before quoting anything, since the search returns titles, not bodies. The path is derived from the public url, so a section page lives at `<path without .mdx>/index.mdx` instead; when `read_file` misses, read that, and if it misses too, `glob` the slug under `apps/web/content/docs`. Then quote the article that states the expected setup or behavior in the evidence record, compare it with the customer's actual state, and treat a contradiction as a User Error candidate with the article link as the unblock. Read code after that, to confirm what the article says or to explain what it does not cover.

### Locate it in the code

`prepare_repository` with `Acquisity/Acquisity`, which refreshes the checkout to the remote HEAD and returns the `worktree` path. Then `grep` and `read_file` under that path to find the code path the claim runs through. Answer what the code is supposed to do before deciding whether it did it.

Record the files and functions, and the commit they were read at: `prepare_repository` does not return one, so take it from `git -C <worktree> rev-parse HEAD`. Without it, a root cause cannot be checked against the code later.

A claim you cannot place in the code is not ready for a Bug verdict.

### Check the data

`planetscale_execute_read_query`, scoped to the organization pinned in Stage 2. Read the rows the claim is about and say whether production state matches the claim, contradicts it, or is silent on it. Prefer a bounded `COUNT` or a narrow `SELECT`.

PlanetScale is the production database and the only source of current production truth. Use the root `planetscale_execute_read_query` tool for this lane. Customer data is never in Neon, and neither the `neon__*` connection nor investigation memory substitutes for this lane.

Then count the blast radius, unscoped from this customer: how many distinct orgs and users are in the same state, each counted once however many times they reported it. Always attempt it, and aim for an exact figure from a query, not an estimate and not an adjective. Record the query and the date counted alongside the number, because the count ages.

When an exact count is genuinely not reachable, say so with the tightest bound the data supports and name what blocks the exact figure. A bounded count with its reason is usable; a vague one is not.

### Check the runtime and provider systems

Pick the lanes the symptom points at. Not every lane applies; naming one as not applicable is an answer, guessing is not.

These systems are indexed on different axes, and most of them are not indexed on the customer. Search each on the axis it actually uses: identity (the org id, user id, or email pinned in Stage 2, never the display name), symptom (the behavior in the product's own words, not the customer's), or time (the window the claim names). One search returning nothing closes nothing. Vary the axis before concluding anything, and if the tool wants an identifier you do not have, resolve it first rather than substituting a name.

A lane you could not figure out how to search is `Could not run`, not evidence of absence. Never report a failed search strategy as a clean result.

Exact tool names, one row per surface. Connection tools are called by their qualified name, `<connection>__<tool>`, so Inngest's `get_run_trace` is `inngest__get_run_trace`; the names below are the server-side names as each connection's allowlist records them. Root tools are called bare, no prefix. `planetscale_execute_read_query` is the trap: it is a root tool, called bare, never as `planetscale__planetscale_execute_read_query`. Never invent a tool name from a service's REST API or CLI; an invented call fails in a way that looks like missing data. When a tool you want is not listed here, use the built-in `connection_search` with the `connection` argument naming one connection to discover what that connection actually exposes; if you cannot, record the lane as `Could not run` rather than trying names until one sticks.

| Surface | Call as | Exact tool names |
| --- | --- | --- |
| Repository | root, bare | `prepare_repository`, `grep`, `glob`, `read_file`, `bash` |
| Help center | root, bare | `find_help_article` |
| Investigation memory | root, bare | `search_investigation_memory`, `record_investigation_case`, `correct_investigation_case` |
| Customer identity | root, bare | `lookup_customer` |
| PlanetScale data | root, bare | `planetscale_execute_read_query`, `describe_table` |
| PlanetScale connection | `planetscale__` | `planetscale_list_organizations`, `planetscale_get_organization`, `planetscale_list_databases`, `planetscale_get_database`, `planetscale_list_branches`, `planetscale_get_branch`, `planetscale_get_insights`, `planetscale_list_schema_recommendations`, `planetscale_search_documentation` |
| Instantly | root, bare | `list_instantly_subworkspaces`, `read_instantly_subworkspace` |
| Linear searches and routing writes | root, bare | `find_related_issues`, `route_ticket`, `save_investigation_document` |
| Linear connection | `linear__` | `list_issues`, `get_issue`, `list_issue_labels`, `save_issue`, `save_document`, `list_comments`, `save_comment` |
| Inngest runs | root, bare | `find_function_runs` |
| Inngest connection | `inngest__` | `list_function_runs`, `list_runs`, `get_run`, `get_run_trace`, `get_event_runs`, `list_functions`, `get_function`, `list_envs`, `query_insights`, `list_insights_tables`, `list_insights_event_schemas`, `get_app`, `get_apps`, `list_webhooks`, `health` |
| Sentry | `sentry__` | `find_organizations`, `find_projects`, `find_issues`, `search_issues`, `get_issue_details`, `search_events`, `search_issue_events` |
| Axiom | `axiom__` | `queryDataset`, `listDatasets`, `getDatasetFields`, `queryMetrics`, `listMetrics`, `searchMetrics`, `listMetricTags`, `getMetricTagValues`, `checkMonitors`, `getMonitorHistory`, `getSavedQueries`, `listDashboards`, `getDashboard`, `exportDashboard`, `listNotifiers` |
| PostHog | `posthog__` | `exec` with a named command: `persons`, `session-recording`, `error-tracking`, `query`, `execute-sql`, `insight`, `event-definition`, `heatmaps` |
| Lucent | `lucent__` | `list_issues`, `get_issue`, `list_insights` |
| Jam | `jam__` | `search`, `fetch`, `listJams`, `getDetails`, `getMetadata`, `getConsoleLogs`, `getNetworkRequests`, `getUserEvents`, `getScreenshots`, `getFrames`, `getVideoTranscript`, `analyzeVideo`, `getRecordingLink`, `getRecordingUrlVerifyLink`, `listRecordingLinks`, `listRecordingLinkJams`, `listRecordingUrls`, `listFolders`, `listMembers` |
| Vercel | `vercel__` | `get_runtime_errors`, `get_runtime_logs`, `list_deployments`, `get_deployment`, `get_deployment_build_logs`, `list_projects`, `get_project`, `list_teams`, `get_web_analytics`, `search_vercel_documentation`, `web_fetch_vercel_url`, `get_access_to_vercel_url`, `list_agent_runs`, `get_agent_run`, `get_agent_run_trace`, `list_agent_run_projects`, `list_toolbar_threads`, `get_toolbar_thread` |
| Intercom | `intercom__` | `search`, `fetch`, `search_conversations`, `get_conversation`, `search_contacts`, `get_contact`, `get_company`, `list_companies` |
| Resend | `resend__` | `list-emails`, `get-email`, `list-logs`, `get-log`, `list-domains`, `get-domain`, `list-suppressions`, `get-suppression`, `list-contacts`, `get-contact`, `list-broadcasts`, `get-broadcast`, `list-templates`, `get-template`, `list-webhooks`, `get-webhook`, `list-segments`, `get-segment`, `list-topics`, `get-topic`, `list-received-emails`, `get-received-email`, `list-received-email-attachments`, `get-received-email-attachment`, `list-sent-email-attachments`, `get-sent-email-attachment` |
| Modem | `modem__` | `search_modem` |

Sentry and PostHog carry no allowlist, so their rows are the confirmed names, not the whole server surface. Resend names are kebab-case, not snake_case: `list_emails` is not a tool, `list-emails` is. The PlanetScale connection is read-only; there is no write tool to reach even by accident, and `planetscale_get_branch_schema` does not exist on it. Read the `planetscale_execute_read_query` result flags before trusting rows: `truncated` means rows are missing, `oversizedRow` means one row alone exceeded the cap, `envelopeTooLarge` means the server returned oversized metadata, `raw` means the result could not be parsed. PlanetScale coordinates are organization `acquisity`, database `acquisity`, branch `main`: `describe_table` and `lookup_customer` carry them fixed, and you pass them yourself on `planetscale_execute_read_query`. The Linear Engineering team id is `8eaf95ab-56ac-4490-8253-f6a96793dc40`; passing the name `Engineering` returns nothing silently. Intercom authorization failures are operator configuration: mark the lane `Could not run` and continue, never ask the requester to reconnect. Vendor docs: Axiom APL at <https://axiom.co/docs/apl/introduction>, Sentry MCP tool source at <https://github.com/getsentry/sentry-mcp>.

- Background work: AI SDR runs, syncs, scrapes, imports, provisioning. Call `find_function_runs` with the function slug from the code path; read `latestTrace.steps` for the step that broke.
- Errors, crashes, stack traces: Sentry `find_issues` first, and `search_issues` only when that finds nothing, then `get_issue_details` for the stacktrace and the first and last seen, to date the failure against the claim. Its natural-language search depends on a provider configured server-side and can be unavailable while the rest works.
- Anything the other lanes do not carry: Axiom `queryDataset` with APL over production logs. Call `listDatasets` and `getDatasetFields` first for real names. APL cannot query metrics; those go through `queryMetrics`.
- Email delivery, bounces, spam placement: Resend `list-emails`, `get-email`, `list-logs`, `list-suppressions`. These names are kebab-case, not snake_case.
- Instantly workspace membership, sending accounts, campaigns, and Unibox delivery state: call the root `list_instantly_subworkspaces` tool first. It follows Workspace Group pages up to a 100-page safety cap and returns only accepted subworkspaces; a cap error is `Could not run` and incomplete evidence, never a complete list. Select a subworkspace by ID when possible; a name must resolve exactly once, and zero, ambiguous, pending, or rejected matches fail closed. Then call `read_instantly_subworkspace`, passing each returned `nextStartingAfter` value back as `startingAfter` until it is null. This provider lane does not replace PlanetScale as current Acquisity production truth.
- What the user actually did: the Jam link on the ticket when there is one, though usually there is not. PostHog runs through a single `exec` tool taking a named command; resolve the person with `persons` on the email or distinct id from Stage 2, then read `session-recording`. It cannot find anyone by display name. Lucent (`list_issues`, `get_issue`) is indexed by symptom, not by customer, so search it for the behavior (`responses not displaying`) and never for who reported it.
- Deployment or edge failures: Vercel `get_runtime_errors` and `get_runtime_logs` around the reported time.
- The conversation behind the report, and whether others hit it: Intercom. A conversation link on the ticket goes straight to `fetch`, which accepts a URL. Otherwise `search_contacts` with the email pinned in Stage 2, then `search_conversations` with `contact_ids`, then `get_conversation` for the full thread; `get_contact` returns the profile only and is not a step on this path. `search` results prefix ids (`contact_<uuid>`) while `contact_ids` wants them raw, so strip the prefix or the filter matches nothing. For whether others hit it, use `search` with a DSL query such as `object_type:conversations q:"campaign stopped sending"`, not `search_conversations`, which filters structured fields and has no free-text. Modem `search_modem` for feedback beyond support threads.

### Record the lanes

Fill the Triage investigation document's Evidence and Ruled out sections with every lane: what it returned, or `Not applicable: <reason>`, or `Could not run: <reason>`. A lane that could not run lowers the verdict's confidence and is named in the report. Contrary evidence must be recorded alongside supporting evidence.

Completion: every material conclusion has current evidence, contrary evidence has been considered, every selected lane is recorded, and unavailable lanes are named honestly. Continue to Stage 5 without reopening trusted intake, identity, or completed evidence unless new conflicting evidence appears.

## Handoff to handling

Stages 5 through 7 and the report templates live in the `triage-handling` skill. Load it once Stage 4 completes, before deciding handling.
