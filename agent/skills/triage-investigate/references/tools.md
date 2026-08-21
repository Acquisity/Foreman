# Investigation tools

Exact tool names for the Step 4 lanes. Every name below was read from this repository: the `tools.allow` list in `agent/connections/<name>.ts`, or the tool's own definition in `agent/tools/`. Names marked as verified externally were confirmed against the vendor's own documentation, linked inline.

Never guess a tool name. A service's REST API, its CLI, and its MCP server rarely share naming, and a call invented from the wrong one fails in a way that reads like the data is missing. When a tool you want is not listed here, read the connection's live tool list first. If you cannot, record the lane as `Could not run` rather than trying names until one sticks.

Two connections have no allowlist and expose their server's full surface, so this file cannot enumerate them completely: Sentry and PostHog. Both are covered below with what is confirmed.

## Repository

`prepare_repository`, `grep`, `glob` are authored tools in `agent/tools/`. `read_file` and `bash` are eve framework tools, registered automatically.

`prepare_repository` takes `Acquisity/Acquisity`, refreshes the checkout to the remote HEAD, and returns `{ worktree, reused }`. It does not return a commit SHA; get it from `git -C <worktree> rev-parse HEAD`.

## PlanetScale

`planetscale_execute_read_query` is an authored tool in `agent/tools/`, not the MCP tool of the same name. The MCP original is deliberately excluded from the allowlist because it returns the full rows array unbounded, which can kill the session; the authored wrapper truncates instead.

Read the result flags before trusting the rows: `truncated` means rows are missing, `oversizedRow` means one row alone exceeded the cap so select fewer columns, `envelopeTooLarge` means the server returned oversized metadata, and `raw` means the result could not be parsed.

Also allowlisted, from the connection: `planetscale_list_databases`, `planetscale_list_branches`, `planetscale_get_database`, `planetscale_get_branch`, `planetscale_get_insights`, `planetscale_list_schema_recommendations`, `planetscale_search_documentation`.

`planetscale_get_branch_schema` is excluded for the same size reason. Read schema through `information_schema` instead.

## Linear

`list_issues`, `get_issue`, `list_issue_labels`, `save_issue`, `save_document`, `list_comments`, `save_comment`.

`save_issue` traps: `labels` replaces the entire label set, so read the current labels and pass the union. `priority` is a number, 1 Urgent through 4 Low. `relatedTo`, `blockedBy`, and `blocks` are append-only. Pass `assignee`, not `assigneeId`.

`save_document` takes exactly one parent; pass `issue` for an issue-scoped document. Use `patch` to edit an existing one rather than rewriting it whole.

The Engineering Team id is `8eaf95ab-56ac-4490-8253-f6a96793dc40`. Passing the name `"Engineering"` returns nothing silently.

## Inngest

`list_function_runs`, `list_runs`, `get_run`, `get_run_trace`, `get_event_runs`, `list_functions`, `get_function`, `list_envs`, `query_insights`, `list_insights_tables`, `list_insights_event_schemas`, `get_app`, `get_apps`, `list_webhooks`, `health`.

Start from the function named in the code path found in 4.2, then `get_run_trace` on a failing run for the step that broke.

## Sentry

No allowlist, so the full server surface is available. Confirmed tool names from the vendor: `find_organizations`, `find_projects`, `find_issues`, `search_issues`, `get_issue_details`, `search_events`, `search_issue_events`.

`get_issue_details` returns the stacktrace and error message for one issue id. The natural-language search tools depend on an LLM provider being configured on the server, so they can be unavailable while the rest of the server works. That is a `Could not run`, not an absence of errors.

Docs: <https://mcp.sentry.dev/>, tool source at <https://github.com/getsentry/sentry-mcp>.

## Axiom

`queryDataset`, `listDatasets`, `getDatasetFields`, `queryMetrics`, `listMetrics`, `searchMetrics`, `listMetricTags`, `getMetricTagValues`, `checkMonitors`, `getMonitorHistory`, `getSavedQueries`, `listDashboards`, `getDashboard`, `exportDashboard`, `listNotifiers`.

`queryDataset` takes APL, which is pipe-delimited: `DatasetName | where ... | summarize ...`. Call `listDatasets` first for real dataset names and `getDatasetFields` for real field names rather than guessing either.

APL cannot query metrics. Metrics go through `queryMetrics`, which uses MPL. A metrics question sent to `queryDataset` fails on syntax, not on data.

Docs: <https://axiom.co/docs/apl/introduction>, worked examples at <https://axiom.co/docs/apl/tutorial>.

## PostHog

No allowlist. The server exposes a single tool, `exec`, which runs a named PostHog command; the `command` parameter's own description carries the syntax. Read it before composing a call.

Commands relevant to an investigation include `persons`, `session-recording`, `error-tracking`, `query`, `execute-sql`, `insight`, `event-definition`, and `heatmaps`.

There is no tool that finds a person by display name. Resolve the person first through `persons` using the email or distinct id pinned in Step 1A, then read their recordings. Composing a call like `posthog_get_session_recordings` will fail; that tool does not exist.

## Lucent

`list_issues`, `get_issue`, `list_insights`.

Indexed by symptom, not by customer. Search the behavior, never who reported it.

## Jam

`search`, `fetch`, `listJams`, `getDetails`, `getMetadata`, `getConsoleLogs`, `getNetworkRequests`, `getUserEvents`, `getScreenshots`, `getFrames`, `getVideoTranscript`, `analyzeVideo`, `getRecordingLink`, `getRecordingUrlVerifyLink`, `listRecordingLinks`, `listRecordingLinkJams`, `listRecordingUrls`, `listFolders`, `listMembers`.

Only useful when the ticket carries a Jam link. `getConsoleLogs` and `getNetworkRequests` are usually worth more than the video.

## Vercel

`get_runtime_errors`, `get_runtime_logs`, `list_deployments`, `get_deployment`, `get_deployment_build_logs`, `list_projects`, `get_project`, `list_teams`, `get_web_analytics`, `search_vercel_documentation`, `web_fetch_vercel_url`, `get_access_to_vercel_url`, `list_agent_runs`, `get_agent_run`, `get_agent_run_trace`, `list_agent_run_projects`, `list_toolbar_threads`, `get_toolbar_thread`.

Query around the time the claim names. A deployment that landed just before the reported window is worth checking against `list_deployments`.

## Intercom

`search_conversations`, `get_conversation`, `search_contacts`, `get_contact`, `get_company`, `list_companies`, `search`, `search_articles`, `list_articles`, `get_article`, `fetch`.

Use it to find whether other customers reported the same thing, which is frequency evidence for severity weighting.

## Resend

`list-emails`, `get-email`, `list-logs`, `get-log`, `list-domains`, `get-domain`, `list-suppressions`, `get-suppression`, `list-contacts`, `get-contact`, `list-broadcasts`, `get-broadcast`, `list-templates`, `get-template`, `list-webhooks`, `get-webhook`, `list-segments`, `get-segment`, `list-topics`, `get-topic`, and the received-email and attachment variants.

These names are kebab-case, not snake_case. `list_emails` is not a tool; `list-emails` is.

## Modem

`search_modem`. Natural-language search over customer feedback.
