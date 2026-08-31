# Intercom product investigation tools

Exact tool names for the Intercom product investigation lanes. Every name below was read from this repository: the `tools.allow` list in `agent/connections/<name>.ts`, or the tool's own definition in `agent/tools/`. Names marked as verified externally were confirmed against the vendor's own documentation, linked inline.

Never guess a tool name. A service's REST API, its CLI, and its MCP server rarely share naming, and a call invented from the wrong one fails in a way that reads like the data is missing.

Two connections have no allowlist and expose their server's full surface, so this file cannot enumerate them completely: Sentry and PostHog. Both are covered below with what is confirmed.

## How tool names work

Two kinds of tool appear below, and they are called differently.

Connection tools live on an MCP server wired up in `agent/connections/`. The model calls them by their qualified name, `<connection>__<tool>`, where the connection name is the filename: `linear__list_issues`, `inngest__get_run_trace`, `planetscale__planetscale_list_databases`. The bare names listed under each heading below are the server-side names as they appear in that connection's `tools.allow`; prefix them with the heading's connection name when you call one.

Root tools are authored in `agent/tools/` or provided by the eve framework. They are called by their bare name with no prefix: `prepare_repository`, `grep`, `glob`, `read_file`, `bash`, `lookup_customer`, `describe_table`, `find_help_article`, `find_function_runs`, `find_ai_stumbles`, `find_related_issues`, `save_investigation_document`, `route_ticket`, `planetscale_execute_read_query`.

`planetscale_execute_read_query` is the trap: it is a root tool, called bare, and it shadows a connection tool of the same name that is deliberately excluded from the allowlist. Never call it as `planetscale__planetscale_execute_read_query`.

Use the built-in `connection_search` with the `connection` argument naming one connection to discover what it actually exposes; never search without it, because that queries every connection at once. When a tool you want is not listed here, search before calling. If you cannot, record the lane as `Could not run` rather than trying names until one sticks.

## Repository (root tools, no prefix)

`prepare_repository`, `grep`, `glob` are authored tools in `agent/tools/`. `read_file` and `bash` are eve framework tools, registered automatically.

`prepare_repository` takes `Acquisity/Acquisity`, refreshes the checkout to the remote HEAD, and returns `{ worktree, reused }`. It does not return a commit SHA; get it from `git -C <worktree> rev-parse HEAD`.

## Help center (root tool, no prefix)

`find_help_article` is one GET against the web app's public `/api/search` route over the 442 help-center articles. No token, every surface. It returns titles, public urls, and likely repository paths (derived from the url; a section page is `<path without .mdx>/index.mdx`); page hits only, five at most, and `error` means the search could not run.

## Investigation memory (root tools, no prefix)

There are three separate database surfaces:

- PlanetScale is the read-only production and customer-data database. Current production evidence comes only from the root `planetscale_execute_read_query` tool.
- Investigation memory is Foreman's own private Postgres store of sanitized past-investigation patterns. It holds no customer data and is reached only through the three root tools in this section.
- The `neon__*` connection investigates other Neon databases. It is unrelated to investigation memory and must never be used to locate, inspect, verify, or repair memory.

`search_investigation_memory`, `record_investigation_case`, and `correct_investigation_case` are authored tools in `agent/tools/`. They are the whole interface to investigation memory. Never list database projects, inspect schemas, roles, indexes, or rows, test SQL, look for credentials, or otherwise hunt for a backing database. If one of these tools answers, the memory wiring is working. If it returns `available: false` or a write fails, record that internally when relevant and continue the investigation without trying another database connection.

`search_investigation_memory` has one retrieval policy for every authorized attended triage surface. It accepts no Linear project metadata and searches the server-owned list of seven live product areas, excludes planned Acquisity Agent cases, identifies every result's area, and returns wider-incident signals separately per area. It does not let the model supply an area list. A projectless Linear issue, a ticket that arrived under `Support`, and an Intercom-native claim all use this same path.

Pass `sourceIssueId` by itself to look up one ticket's own case, which is how you find the case id to correct. That project-independent identity form ignores product lifecycle, relevance filters, and the time window. An unauthorized session, an unreachable store, and an unconfigured store return `available: false`; none blocks the investigation. That is not the same as `available: true` with an empty `cases` list: empty means the source has no active case, unavailable means nothing is known, so a correction must not be recorded as a fresh case on the strength of an unavailable lookup. Results are capped at 10, default 5.

`record_investigation_case` runs once per source, when the verdict is settled. For a Linear ticket, record after the Triage investigation document is attached, the classification is final, and final Linear handling has saved the evidence-backed product project; re-read the issue and pass that resulting project id. For a ticketless Intercom or Slack investigation, `sourceIssueId` is `intercom:<conversation id>` or `slack:<channel id>/<thread ts>`, the project id is omitted, and `primaryFeatureKey` names the live product area the evidence points at. It refuses payloads carrying email addresses, organization or user ids, connection strings, or credential-shaped tokens, so keep those in the document. A second write for the same source is refused: a changed conclusion, including one a colleague corrected in the thread, goes through `correct_investigation_case`, which takes the full corrected case plus the active case id. Keep the `caseId` the original write returned. A later session will not have it, so pass `sourceIssueId` to `search_investigation_memory` to get it back. That is an identity lookup rather than a search: it ignores product lifecycle, relevance filters, and the time window, so neither ranking nor a case older than a year can hide it. The result cap still applies, which costs nothing here because a source has exactly one active case. When a colleague overturns a conclusion that was never recorded, `record_investigation_case` records the corrected conclusion with the overturned one in `ruledOut`.

Both writes are denied outright in sessions that are not authorized triage surfaces, and in unattended runs. The denial is the answer; there is no approval card to wait on. Memory reads, writes, and availability are internal bookkeeping and never belong in a Slack-facing reply.

## PlanetScale (`planetscale__`)

`lookup_customer` is the identity gate: one fixed production query from a customer email to the user, live memberships, and `pinnedOrganizationId`. It is a root tool, called bare. Use it instead of writing the identity join yourself.

`planetscale_execute_read_query` is an authored tool in `agent/tools/`, not the MCP tool of the same name. The MCP original is deliberately excluded from the allowlist because it returns the full rows array unbounded, which can kill the session; the authored wrapper truncates instead.

Read the result flags before trusting the rows: `truncated` means rows are missing, `oversizedRow` means one row alone exceeded the cap so select fewer columns, `envelopeTooLarge` means the server returned oversized metadata, and `raw` means the result could not be parsed.

Also allowlisted, from the connection: `planetscale_list_organizations`, `planetscale_get_organization`, `planetscale_list_databases`, `planetscale_get_database`, `planetscale_list_branches`, `planetscale_get_branch`, `planetscale_get_insights`, `planetscale_list_schema_recommendations`, `planetscale_search_documentation`. That is the whole surface; there is no write tool to reach even by accident.

`planetscale_get_branch_schema` does not exist on this connection, and the MCP server does not register it either, so it fails as an unknown tool rather than a permission error. Unsure of a table or column name: call `describe_table` first. It is a root tool, called bare, and returns the table's columns with types from `information_schema`, or `found` false with similar table names; `found` false with no `error` means no public table has that name, while `error` means the lookup could not run and the name is unverified. Do not guess names into a query.

Connection coordinates, confirmed live: organization `acquisity`, database `acquisity`, branch `main`. `describe_table` and `lookup_customer` carry them fixed; pass them yourself on `planetscale_execute_read_query`.

## Instantly (root tools, no prefix)

`list_instantly_subworkspaces`, `read_instantly_subworkspace`.

Both are fixed GET-only tools backed by the app-scoped IBG admin-workspace credential. They are available only on attended investigation surfaces and never start caller OAuth. `available: false` means `Could not run`; an authorization failure is connector, key, scope, or workspace-group configuration, not a reason to ask the requester to sign in or retry the same call.

Call `list_instantly_subworkspaces` first. It follows Workspace Group pages up to a 100-page safety cap, returns only accepted subworkspaces, reports pending/rejected counts without exposing those workspaces, and includes the admin workspace name and ID. Treat a cap error as `Could not run` and incomplete evidence, never as a complete list. Prefer the selected subworkspace's ID. Name selection in `read_instantly_subworkspace` is normalized but must resolve exactly once; zero, ambiguous, pending, and rejected matches fail closed.

`read_instantly_subworkspace` accepts `accounts`, `campaigns`, or `emails`, adds `x-as-workspace` server-side only after validating the selection, and returns the workspace name and ID on every page. Pass `nextStartingAfter` back as `startingAfter` until it is null. Every resource uses an explicit investigative-field allowlist. Email reads always use preview-only mode and remove message bodies, attachment payloads, and all provider address representations. Short 429 and transient failures receive bounded retries; a longer rate limit returns its safe retry interval. There is no generic path, method, header, or body input and no mutation route.

## Linear (`linear__`)

`list_issues`, `get_issue`, `list_issue_labels`, `save_issue`, `save_document`, `list_comments`, `save_comment`.

`find_related_issues` is a root tool, called bare: fixed duplicate and master searches through the same Linear installation, phrases in, deduped hits out with the phrases that matched each. Use it for the Stage 3 duplicate search and the master search instead of composing `list_issues` filters; `list_issues` stays for everything else.

`route_ticket` is a root tool, called bare: the final routing write. It adds labels to the ticket's existing set (unknown names fail and list the valid ones), resolves state, project, and assignee by name, inherits an assignee from a master or parent, records a duplicate relation, attaches links, and reads the ticket back with the saved `projectId`. Use it for every routing write in these skills; `save_issue` stays for creating issues and for description edits. `save_issue`'s `labels` field replaces the whole set, which is why routing does not go through it.

`save_investigation_document` is a root tool, called bare: it owns the ticket's `Triage investigation` (or `Billing investigation`) document, creating it once and rewriting it after, and returns the `documentId` and `updatedAt` version pin. Do not write that document through `save_document`.

The Engineering Team id is `8eaf95ab-56ac-4490-8253-f6a96793dc40`. Passing the name `"Engineering"` returns nothing silently.

## Inngest (`inngest__`)

`list_function_runs`, `list_runs`, `get_run`, `get_run_trace`, `get_event_runs`, `list_functions`, `get_function`, `list_envs`, `query_insights`, `list_insights_tables`, `list_insights_event_schemas`, `get_app`, `get_apps`, `list_webhooks`, `health`.

Call `find_function_runs` with the function slug from the Code lane under `Investigate current evidence`. It is a root tool, called bare: the newest runs with the given status in the window, and `latestTrace.steps`, the trace steps of the newest matching run, with any step error bounded and redacted. Omit the slug to see matching runs across every function first. The connection tools above stay for anything else, such as a specific event's runs.

## Sentry (`sentry__`)

No allowlist, so the full server surface is available. Confirmed tool names from the vendor: `find_organizations`, `find_projects`, `find_issues`, `search_issues`, `get_issue_details`, `search_events`, `search_issue_events`.

`get_issue_details` returns the stacktrace and error message for one issue id. The natural-language search tools depend on an LLM provider being configured on the server, so they can be unavailable while the rest of the server works. That is a `Could not run`, not an absence of errors.

Docs: <https://mcp.sentry.dev/>, tool source at <https://github.com/getsentry/sentry-mcp>.

## Axiom (`axiom__`)

`queryDataset`, `listDatasets`, `getDatasetFields`, `queryMetrics`, `listMetrics`, `searchMetrics`, `listMetricTags`, `getMetricTagValues`, `checkMonitors`, `getMonitorHistory`, `getSavedQueries`, `listDashboards`, `getDashboard`, `exportDashboard`, `listNotifiers`.

`queryDataset` takes APL, which is pipe-delimited: `DatasetName | where ... | summarize ...`. Call `listDatasets` first for real dataset names and `getDatasetFields` for real field names rather than guessing either.

APL cannot query metrics. Metrics go through `queryMetrics`, which uses MPL. A metrics question sent to `queryDataset` fails on syntax, not on data.

Docs: <https://axiom.co/docs/apl/introduction>, worked examples at <https://axiom.co/docs/apl/tutorial>.

## PostHog (`posthog__`)

No allowlist. The server exposes a single tool, `exec`, which runs a named PostHog command; the `command` parameter's own description carries the syntax. Read it before composing a call.

Commands relevant to an investigation include `persons`, `session-recording`, `error-tracking`, `query`, `execute-sql`, `insight`, `event-definition`, and `heatmaps`.

There is no tool that finds a person by display name. Resolve the person first through `persons` using the email or distinct id established under `Pin identity and check existing evidence`, then read their recordings. Composing a call like `posthog_get_session_recordings` will fail; that tool does not exist.

## Raindrop (root tool, no prefix)

`find_ai_stumbles`. One fixed call over the Raindrop connection: the one-off failures Raindrop flagged in the product's AI interactions (AI SDR replies, the assistant), newest first, 50 per page.

Indexed by symptom and time, never by customer. Pass the behavior in the product's own words as `query` (`meeting time`, `wrong company name`) and the window the claim names as `sinceHours`; omit `query` to list everything in the window. Each stumble carries `eventAt`, when the interaction happened, and Raindrop's tags. Raindrop scans every `cadenceMinutes`, so frame findings as of `lastRunAt`, not live. `hasMore` true means call again with `page` + 1. `error` means the search could not run; record the lane as `Could not run`. The `raindrop__` connection tools stay for a specific event, trace, or conversation once a stumble names the time.

## Lucent (`lucent__`)

`list_issues`, `get_issue`, `list_insights`.

Indexed by symptom, not by customer. Search the behavior, never who reported it.

## Jam (`jam__`)

`search`, `fetch`, `listJams`, `getDetails`, `getMetadata`, `getConsoleLogs`, `getNetworkRequests`, `getUserEvents`, `getScreenshots`, `getFrames`, `getVideoTranscript`, `analyzeVideo`, `getRecordingLink`, `getRecordingUrlVerifyLink`, `listRecordingLinks`, `listRecordingLinkJams`, `listRecordingUrls`, `listFolders`, `listMembers`.

Only useful when the ticket carries a Jam link. `getConsoleLogs` and `getNetworkRequests` are usually worth more than the video.

## Vercel (`vercel__`)

`get_runtime_errors`, `get_runtime_logs`, `list_deployments`, `get_deployment`, `get_deployment_build_logs`, `list_projects`, `get_project`, `list_teams`, `get_web_analytics`, `search_vercel_documentation`, `web_fetch_vercel_url`, `get_access_to_vercel_url`, `list_agent_runs`, `get_agent_run`, `get_agent_run_trace`, `list_agent_run_projects`, `list_toolbar_threads`, `get_toolbar_thread`.

Query around the time the claim names. A deployment that landed just before the reported window is worth checking against `list_deployments`.

## Intercom (`intercom__`)

`search`, `fetch`, `search_conversations`, `get_conversation`, `search_contacts`, `get_contact`, `get_company`, `list_companies`.

Intercom is app-scoped through the private Acquisity workspace app token. There is no caller OAuth or sign-in flow. If discovery or a tool reports an authorization failure, mark the lane `Could not run` and continue with other evidence. Do not ask the Slack requester to reconnect, do not wait for consent, and do not retry the same call. The failure is operator configuration.

Two uses.

The conversation behind this report. Pass the intake URL straight to `fetch`, which accepts a URL. When the intake supplies a known conversation id instead, use `get_conversation`. Only when no conversation URL or id is available and the identity gate has established an exact email, use `search_contacts`, then `search_conversations` with `contact_ids`, then `get_conversation` for the full thread. `get_contact` returns the profile only and holds no conversations, so it is not a step on this path.

Whether others hit the same thing, which is frequency evidence for severity weighting. Use `search`, not `search_conversations`: `search_conversations` filters structured fields and has no free-text, while `search` takes a DSL query such as `object_type:conversations q:"campaign stopped sending"`.

`search` returns ids prefixed (`contact_<uuid>`), but `contact_ids` wants them raw. Strip the prefix or the filter matches nothing.

## Resend (`resend__`)

`list-emails`, `get-email`, `list-logs`, `get-log`, `list-domains`, `get-domain`, `list-suppressions`, `get-suppression`, `list-contacts`, `get-contact`, `list-broadcasts`, `get-broadcast`, `list-templates`, `get-template`, `list-webhooks`, `get-webhook`, `list-segments`, `get-segment`, `list-topics`, `get-topic`, `list-received-emails`, `get-received-email`, `list-received-email-attachments`, `get-received-email-attachment`, `list-sent-email-attachments`, `get-sent-email-attachment`.

These names are kebab-case, not snake_case. `list_emails` is not a tool; `list-emails` is.

## Modem (`modem__`)

`search_modem`. Natural-language search over customer feedback.
