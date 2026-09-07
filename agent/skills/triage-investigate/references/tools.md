# Triage tool catalog

Company-service tools use Executor. Use `connection_search` with the `connection` argument set to the Executor connection named in this turn's access instructions. Inside `execute`, search one provider namespace with `tools.search({ namespace, query })`, inspect `tools.describe.tool({ path })`, and call the returned `tools[path](input)`. Check `result.ok` before reading `result.data`. The provider tool names below are search hints, not callable Executor addresses. Never guess paths or use a removed direct provider connection. Authored Foreman helpers keep their bare names and require no discovery.

The triage-investigate skill mandates loading this catalog at the start of Stage 4, before the first evidence lane runs; every lane call uses a name from this catalog.

| Surface | Call as | Exact tool names |
| --- | --- | --- |
| Repository | root, bare | `prepare_repository`, `grep`, `glob`, `read_file`, `bash` |
| Help center | root, bare | `find_help_article` |
| Investigation memory | root, bare | `search_investigation_memory`, `record_investigation_case`, `correct_investigation_case` |
| Customer identity | root, bare | `lookup_customer` |
| PlanetScale data | root, bare | `planetscale_execute_read_query`, `describe_table` |
| PlanetScale connection | Executor: planetscale | `planetscale_list_organizations`, `planetscale_get_organization`, `planetscale_list_databases`, `planetscale_get_database`, `planetscale_list_branches`, `planetscale_get_branch`, `planetscale_get_insights`, `planetscale_list_schema_recommendations`, `planetscale_search_documentation` |
| Instantly | root, bare | `list_instantly_subworkspaces`, `read_instantly_subworkspace` |
| Linear searches and routing writes | root, bare | `find_related_issues`, `route_ticket`, `save_investigation_document` |
| Linear connection | Executor: linear | `list_issues`, `get_issue`, `list_issue_labels`, `save_issue`, `save_document`, `list_comments`, `save_comment` |
| Inngest runs | root, bare | `find_function_runs` |
| Inngest connection | Executor: inngest | `list_function_runs`, `list_runs`, `get_run`, `get_run_trace`, `get_event_runs`, `list_functions`, `get_function`, `list_envs`, `query_insights`, `list_insights_tables`, `list_insights_event_schemas`, `get_app`, `get_apps`, `list_webhooks`, `health` |
| Sentry | Executor: sentry | `find_organizations`, `find_projects`, `find_issues`, `search_issues`, `get_issue_details`, `search_events`, `search_issue_events` |
| Axiom | Executor: axiom | `queryDataset`, `listDatasets`, `getDatasetFields`, `queryMetrics`, `listMetrics`, `searchMetrics`, `listMetricTags`, `getMetricTagValues`, `checkMonitors`, `getMonitorHistory`, `getSavedQueries`, `listDashboards`, `getDashboard`, `exportDashboard`, `listNotifiers` |
| PostHog | Executor: posthog | `exec` with a named command: `persons`, `session-recording`, `error-tracking`, `query`, `execute-sql`, `insight`, `event-definition`, `heatmaps` |
| Lucent | Executor: lucent | `list_issues`, `get_issue`, `list_insights` |
| Jam | Executor: jam | `search`, `fetch`, `listJams`, `getDetails`, `getMetadata`, `getConsoleLogs`, `getNetworkRequests`, `getUserEvents`, `getScreenshots`, `getFrames`, `getVideoTranscript`, `analyzeVideo`, `getRecordingLink`, `getRecordingUrlVerifyLink`, `listRecordingLinks`, `listRecordingLinkJams`, `listRecordingUrls`, `listFolders`, `listMembers` |
| Vercel | Executor: vercel | `get_runtime_errors`, `get_runtime_logs`, `list_deployments`, `get_deployment`, `get_deployment_build_logs`, `list_projects`, `get_project`, `list_teams`, `get_web_analytics`, `search_vercel_documentation`, `web_fetch_vercel_url`, `get_access_to_vercel_url`, `list_agent_runs`, `get_agent_run`, `get_agent_run_trace`, `list_agent_run_projects`, `list_toolbar_threads`, `get_toolbar_thread` |
| Intercom | Executor: intercom | `search`, `fetch`, `search_conversations`, `get_conversation`, `search_contacts`, `get_contact`, `get_company`, `list_companies` |
| Resend | Executor: resend | `list-emails`, `get-email`, `list-logs`, `get-log`, `list-domains`, `get-domain`, `list-suppressions`, `get-suppression`, `list-contacts`, `get-contact`, `list-broadcasts`, `get-broadcast`, `list-templates`, `get-template`, `list-webhooks`, `get-webhook`, `list-segments`, `get-segment`, `list-topics`, `get-topic`, `list-received-emails`, `get-received-email`, `list-received-email-attachments`, `get-received-email-attachment`, `list-sent-email-attachments`, `get-sent-email-attachment` |
| Modem | Executor: modem | `search_modem` |

Sentry and PostHog carry no allowlist; their rows are the confirmed names, not the whole surface. Resend names are kebab-case, not snake_case: `list_emails` is not a tool, `list-emails` is. The PlanetScale connection is read-only with no write tool to reach even by accident; `planetscale_get_branch_schema` does not exist. Read the `planetscale_execute_read_query` result flags before trusting rows: `truncated` (rows missing), `oversizedRow` (one row exceeded the cap), `envelopeTooLarge` (oversized metadata), `raw` (unparseable). Coordinates are organization `acquisity`, database `acquisity`, branch `main`: `describe_table` and `lookup_customer` carry them fixed; pass them yourself on `planetscale_execute_read_query`. The Linear Engineering team id is `8eaf95ab-56ac-4490-8253-f6a96793dc40`; the name `Engineering` returns nothing silently. Intercom authorization failures are operator configuration: mark the lane `Could not run` and continue. For either Instantly tool, `available: false` also means `Could not run`: it is operator configuration, never a reason to ask the requester to sign in or retry.
