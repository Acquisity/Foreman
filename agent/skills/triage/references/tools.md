# Triage and billing tool catalog

Company-service tools come through Executor. Discover and call them exactly as this session's Executor discovery instructions say; the provider names below are search hints, never callable addresses, so never guess paths. Authored Foreman helpers keep their bare names and require no discovery.

One catalog for product triage and billing triage, from a Linear ticket, a Slack intake thread or an Intercom conversation. Never invent a tool name from a service's REST API or CLI: an invented call fails in a way that reads like the customer has no data.

| Surface | Call as | Exact tool names |
| --- | --- | --- |
| Repository | root, bare | `prepare_repository`, `grep`, `glob`, `read_file`, `bash` |
| Help center | root, bare | `find_help_article` |
| Investigation memory | root, bare | `search_investigation_memory`, `record_investigation_case`, `correct_investigation_case` |
| Customer identity | root, bare | `lookup_customer` |
| PlanetScale data | root, bare | `planetscale_execute_read_query`, `describe_table` |
| PlanetScale connection | Executor: planetscale | `planetscale_list_organizations`, `planetscale_get_organization`, `planetscale_list_databases`, `planetscale_get_database`, `planetscale_list_branches`, `planetscale_get_branch`, `planetscale_get_insights`, `planetscale_list_schema_recommendations`, `planetscale_search_documentation` |
| Billing records | root, bare | `read_billing_account`, `read_autumn_billing`, `read_stripe_billing` |
| Autumn | Executor: autumn | `getCustomer`, `getPlan`, `listPlans`, `listFeatures`, `getEntity`, `listEntities`, `listCustomers`, `getCurrentOrganization` |
| Stripe | Executor: stripe | `stripe_api_read`, `stripe_api_search`, `stripe_api_details`, `search_stripe_documentation`, `list_available_accounts_or_orgs` |
| Instantly | root, bare | `list_instantly_subworkspaces`, `read_instantly_subworkspace` |
| Jev decisions | root, bare | `classify_ask`, `decide_prior_work`, `decide_triage`, `decide_billing`, `check_reply` |
| Linear searches and routing writes | root, bare | `find_related_issues`, `route_ticket`, `save_investigation_document` |
| Linear connection | Executor: linear | `list_issues`, `get_issue`, `list_issue_labels`, `list_projects`, `save_issue`, `save_document`, `list_comments`, `save_comment` |
| Inngest runs | root, bare | `find_function_runs` |
| Inngest connection | Executor: inngest | `list_function_runs`, `list_runs`, `get_run`, `get_run_trace`, `get_event_runs`, `list_functions`, `get_function`, `list_envs`, `query_insights`, `list_insights_tables`, `list_insights_event_schemas`, `get_app`, `get_apps`, `list_webhooks`, `health` |
| Sentry | Executor: sentry | `find_organizations`, `find_projects`, `search_issues`, `search_events`, `search_sentry_tools`, `execute_sentry_tool`; discover the nested `get_issue_details` and `search_issue_events` read schemas before invoking them |
| Axiom | Executor: axiom | `queryDataset`, `listDatasets`, `getDatasetFields`, `queryMetrics`, `listMetrics`, `searchMetrics`, `listMetricTags`, `getMetricTagValues`, `checkMonitors`, `getMonitorHistory`, `getSavedQueries`, `listDashboards`, `getDashboard`, `exportDashboard`, `listNotifiers` |
| PostHog | Executor: posthog | `persons_list`, `query_session_recordings_list`, `session_recording_get`, `read_data_schema`, `query_trends`, `query_web_stats`, `execute_sql`; inspect each installed schema |
| Lucent | Executor: lucent | `list_issues`, `get_issue`, `list_insights` |
| Raindrop | Executor: raindrop | `list_projects`, `search_events`, `list_events`, `get_event`, `get_trace`, `get_conversation`, `list_signals`, `get_signal`, `list_issues`, `get_issue`, `get_issue_events`, `search_stumbles`, `query_cost` |
| Jam | Executor: jam | `search`, `fetch`, `listJams`, `getDetails`, `getMetadata`, `getConsoleLogs`, `getNetworkRequests`, `getUserEvents`, `getScreenshots`, `getFrames`, `getVideoTranscript`, `analyzeVideo`, `getRecordingLink`, `getRecordingUrlVerifyLink`, `listRecordingLinks`, `listRecordingLinkJams`, `listRecordingUrls`, `listFolders`, `listMembers` |
| Vercel | Executor: foreman_vercel_api | Foreman-scoped projects (`getProject`, `getProjects`), deployments (`getDeployments`, `getDeployment`), build logs (`getDeploymentEvents`), and runtime logs (`getRuntimeLogs`). Discover the exact path and schema before calling. |
| Intercom | Executor: intercom | `search`, `fetch`, `search_conversations`, `get_conversation`, `search_contacts`, `get_contact`, `get_company`, `list_companies` |
| Resend | Executor: resend | `list_emails`, `get_email`, `list_logs`, `get_log`, `list_domains`, `get_domain`, `list_suppressions`, `get_suppression`, `list_contacts`, `get_contact`, `list_broadcasts`, `get_broadcast`, `list_templates`, `get_template`, `list_webhooks`, `get_webhook`, `list_segments`, `get_segment`, `list_topics`, `get_topic`, `list_received_emails`, `get_received_email`, `list_received_email_attachments`, `get_received_email_attachment`, `list_sent_email_attachments`, `get_sent_email_attachment` |
| Modem | Executor: modem | `search_modem` |

Every company surface is constrained by the active Executor toolkit allowlist. These rows are discovery hints for the installed catalog, not permission to call an unlisted operation. Resend currently publishes snake_case names. Raindrop is read-only evidence about how Acquisity's own AI features behaved: LLM events, traces, signals, issues, and cost. Sentry issue details and event reads are nested catalog operations; PostHog publishes individual read tools rather than the old `exec` dispatcher. Intercom authorization failures are operator configuration: mark the lane `Could not run`, never ask the requester to reconnect, and do not retry the same call. For either Instantly tool, `available: false` also means `Could not run`: it is operator configuration, never a reason to ask the requester to sign in or retry.

## PlanetScale

The PlanetScale connection is read-only with no write tool to reach even by accident; `planetscale_get_branch_schema` is available through Executor for full-schema reads; filter and summarize its result inside Executor before returning it. `planetscale_execute_read_query` is the authored helper, called bare; Executor exposes a provider operation of the same name without the helper's result bounds, so prefer the helper. Read its result flags before trusting rows: `truncated` (rows missing), `oversizedRow` (one row exceeded the cap; select fewer columns), `envelopeTooLarge` (oversized metadata), `raw` (unparseable). An amount computed from a truncated result is wrong. Coordinates are organization `acquisity`, database `acquisity`, branch `main`: `describe_table` and `lookup_customer` carry them fixed; pass them yourself on `planetscale_execute_read_query`. Unsure of a table or column, call `describe_table` first.

## Linear

The Linear Engineering team id is `8eaf95ab-56ac-4490-8253-f6a96793dc40`; the name `Engineering` returns nothing silently. `route_ticket` is the routing write: it adds labels to the existing set (an unknown name fails and lists the valid ones), resolves state, project, and assignee by name, records relations and links, and reads the ticket back with its `projectId`. `save_issue` is for creating issues and editing descriptions only: its `labels` field replaces the whole set, and `priority` is a number, 1 Urgent through 4 Low. `save_investigation_document` owns the ticket's one `Triage investigation` or `Billing investigation` document; never write those through `save_document`.

## Billing records (read in this order)

- `read_billing_account` takes the pinned organization: organization with `partnerGoverned`, billing account, wallets, credit balances, and recent credit history, with a `truncated` flag per list.
- `read_autumn_billing` takes `billingAccount.id`, never the organization id, which answers `customer_not_found`. A 404 is a wrong id: re-resolve before recording anything, except for a partner-governed organization, which is on Whop and has no customer in Acquisity's own Autumn. Its `stripe_id` is the `cus_` id Stripe needs. Domain and inbox line items are named generically; the identifier is in the metadata, shaped `xxxxxxxxx{domain.co}`, so read metadata on every line item before counting or matching.
- `read_stripe_billing`: `customer` with the `cus_` id for at most 20 recent subscriptions, invoices, charges, credit notes, and balance transactions; `charge`, `refund`, or `dispute` for a known object; `promotion_code` for a customer-facing code; `coupon` for a known coupon id. `has_more: true` means incomplete history: read the exact object before any amount or refund verdict. A per-section error leaves that section unverified. Amounts are in the smallest currency unit (`7200` is $72.00); read `amount_refunded`, the customer balance, and credit notes before proposing a credit.

All three are fixed reads on the shared app-scoped connection, so no requester signs in and nothing can move money. When `read_autumn_billing` or `read_stripe_billing` answers `available: false` because it could not run, the Executor Autumn or Stripe reads above are the read-only fallback; a 404 is not that case. Autumn and Stripe write tools are not allowlisted: `getOrCreateCustomer` creates on a miss, so it is excluded, and the `preview*` operations compute without applying anything. Propose any refund or credit for a human; never invent a `create_refund` tool.

## Instantly evidence bounds

Both authored helpers validate the complete accepted membership set before returning evidence. Find workspaces with `list_instantly_subworkspaces({ search: "customer name fragment" })`; no internal ID is needed. Search is a literal, case-insensitive name match. Results contain at most `limit` entries (default 20, maximum 100, also bounded to 256 KiB), `totalMatches`, `totalAcceptedSubworkspaces`, and `nextStartingAfter`. Pass each returned `nextStartingAfter` as `startingAfter` with the same search until null when more candidates need review; `{}` browses a bounded first page. `membershipComplete` describes internal validation, not whether this public page contains every match. Choose the evidence-backed candidate and pass its returned ID to `read_instantly_subworkspace`; do not guess between ambiguous names or equate a product display name with provider identity. A 100-page source cap means membership is incomplete and the lane could not run. Zero search matches prove only that this name fragment did not resolve, not absent provisioning. Try other evidence-backed names or the linked provider ID in the pinned production scope; if identity remains unknown, mark provider resource state unverified. A matched, successful resource read may return valid empty results. Instantly proves provider state only, never payment, entitlement, or a refund amount.

## Regression check

`check_regression` (root, bare) is the one tool for git history and production's commit: it deepens the checkout to 30 days, lists the commits that touched a line range and, once each is labelled, returns the result line. It reads production's commit from GitHub itself. [regression-check.md](regression-check.md) says how to call it.
