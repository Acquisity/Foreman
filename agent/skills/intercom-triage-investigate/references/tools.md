# Intercom product investigation tools

The `intercom-triage-investigate` skill mandates loading this catalog before the first evidence lane runs; every lane call uses a name from this catalog. The table below is the same shared catalog `triage-investigate` carries, kept identical on purpose; the Intercom-specific notes follow it.

Exact tool names, one row per surface. Connection tools are called by qualified name, `<connection>__<tool>`; root tools are called bare. `planetscale_execute_read_query` is the trap: a root tool, called bare, never as `planetscale__planetscale_execute_read_query`. Never invent a tool name from a service's REST API or CLI; an invented call fails in a way that looks like missing data. Use the built-in `connection_search` with the `connection` argument naming one connection to discover what it actually exposes; never search without it, because that queries every connection at once. If you cannot search, record the lane as `Could not run`.

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

Sentry and PostHog carry no allowlist; their rows are the confirmed names, not the whole surface. Resend names are kebab-case, not snake_case: `list_emails` is not a tool, `list-emails` is. The PlanetScale connection is read-only with no write tool to reach even by accident; `planetscale_get_branch_schema` does not exist. Read the `planetscale_execute_read_query` result flags before trusting rows: `truncated` (rows missing), `oversizedRow` (one row exceeded the cap), `envelopeTooLarge` (oversized metadata), `raw` (unparseable). Coordinates are organization `acquisity`, database `acquisity`, branch `main`: `describe_table` and `lookup_customer` carry them fixed; pass them yourself on `planetscale_execute_read_query`. The Linear Engineering team id is `8eaf95ab-56ac-4490-8253-f6a96793dc40`; the name `Engineering` returns nothing silently. Intercom authorization failures are operator configuration: mark the lane `Could not run` and continue. For either Instantly tool, `available: false` also means `Could not run`: it is operator configuration, never a reason to ask the requester to sign in or retry.

## Intercom (`intercom__`)

Intercom is app-scoped through the private Acquisity workspace app token. There is no caller OAuth or sign-in flow, so an authorization failure is operator configuration: mark the lane `Could not run`, do not ask the Slack requester to reconnect, and do not retry the same call.

Two uses. The conversation behind this report: pass the intake URL straight to `fetch`, which accepts a URL; when the intake supplies a known conversation id instead, use `get_conversation`. Only when no conversation URL or id is available and the identity gate has established an exact email, use `search_contacts`, then `search_conversations` with `contact_ids`, then `get_conversation` for the full thread. `get_contact` returns the profile only and is not a step on that path.

Whether others hit the same thing, which is frequency evidence for severity weighting: use `search` with a DSL query such as `object_type:conversations q:"campaign stopped sending"`, not `search_conversations`, which filters structured fields and has no free-text. `search` returns ids prefixed (`contact_<uuid>`) while `contact_ids` wants them raw, so strip the prefix or the filter matches nothing.

## Investigation memory on this surface

`search_investigation_memory` accepts no Linear project metadata and searches the server-owned live product areas for every authorized attended triage surface, so an Intercom-native claim takes the same path as a projectless Linear ticket. Pass `sourceIssueId` by itself to look up one source's own case, which is how you find the case id to correct. `available: false` never blocks the investigation, and it is not the same as an empty `cases` list.

`record_investigation_case` runs once per source, when the verdict is settled. For a Bug, `triage-handling` Stage 7 owns the write under the report's ticket identifier. Every other verdict is recorded by the skill's Step 8 with a ticketless source id, `intercom:<conversation id>` for a conversation and `slack:<channel id>/<thread ts>` for a thread, no project id, and `primaryFeatureKey` naming the live product area. A second write for the same source is refused: a changed conclusion, including one a colleague corrected in the thread, goes through `correct_investigation_case` with the full corrected case.
