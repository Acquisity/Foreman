# Critic evidence surface

Every source a triage investigation can cite, and how the critic reaches it. Each entry is the root Foreman definition mounted into the child; the credential path is the root's own `managedConnect` or `userConnect` object, reused as is. The critic holds no connector, token, or credential of its own and can never write.

Connection tools are called as `<connection>__<tool>`; use `connection_search` to discover what a connection exposes before calling one. Root tools are called by their bare name and are always present without any search: never report one as unavailable unless you called it and it failed or answered `available: false`.

## Repository (root tools)

`prepare_repository` then `checkout_commit`, both bare. `glob`, `grep`, and `read_file` read the pinned checkout at `/workspace/repo`. There is no `bash`.

## Production data (root tool)

`planetscale_execute_read_query`, bare. Coordinates, confirmed live: `organization` `acquisity`, `database` `acquisity`, `branch` `main`, and `postgres_database_name` `postgres` (not `acquisity`; passing the wrong one fails with "database does not exist"). Truncates rather than returning unbounded rows; read the `truncated`, `oversizedRow`, `envelopeTooLarge`, and `raw` flags before trusting a result. Read schema through `information_schema.columns` with `postgres_database_name` set; `planetscale_get_branch_schema` does not exist. The `planetscale__` connection also exposes the organization, database, branch, insights, and documentation reads; its write tool is excluded at the root.

## Investigation memory (root tool)

`search_investigation_memory`, bare. Analogy only, never current truth. `available: false` is normal when the child session carries no memory stamp; record it and move on. It takes no Linear project id.

## Provider and runtime evidence (connections)

| Source | Connection | Auth class | Read boundary |
| --- | --- | --- | --- |
| Linear issues, comments, labels, documents | `linear__` | app, managed | child allowlist: `get_issue`, `list_issues`, `list_comments`, `list_issue_labels`, `get_document`, `list_documents` |
| Intercom conversations and contacts | `intercom__` | app, managed | root allowlist, reads only |
| Inngest runs, traces, functions | `inngest__` | app, managed | root allowlist, reads only |
| Lucent issues and insights | `lucent__` | app, managed | root allowlist, reads only |
| Sentry issues and events | `sentry__` | user | child allowlist: the seven confirmed read tools |
| Axiom datasets, metrics, monitors | `axiom__` | user | root allowlist, reads only |
| Vercel deployments, logs, errors, analytics | `vercel__` | user | root allowlist minus the five write tools |
| PostHog persons, recordings, errors, queries | `posthog__` | user | one `exec` tool; read-only by OAuth scope, so any write command fails at the API |
| Resend emails, logs, domains | `resend__` | user | root allowlist, reads only |
| Jam recordings, console, network | `jam__` | user | root allowlist, reads only |
| Modem customer feedback search | `modem__` | user | root allowlist: `search_modem` |
| Neon, only when the code path uses a Neon database | `neon__` | user | read-only endpoint plus root allowlist; never customer data, never memory |
| Autumn provisioning | `autumn__` | user | root allowlist, reads only |
| Stripe billing | `stripe__` | user | root allowlist, reads only |

## Call notes for the connections

- Linear: the Engineering Team id is `8eaf95ab-56ac-4490-8253-f6a96793dc40`; passing the name `"Engineering"` to `list_issues` returns nothing silently. Page with `limit: 250` and the cursor until exhausted.
- Intercom: pass an Intercom URL straight to `fetch`. Free-text search is `search` with a DSL query such as `object_type:conversations q:"campaign stopped sending"`; `search_conversations` filters structured fields only. `search` returns prefixed ids (`contact_<uuid>`) and `contact_ids` wants them raw.
- Inngest: `find_function_runs` with the function id from the code path covers the runs and the newest trace; the connection tools stay for a specific event's runs or an older run's trace.
- Sentry: `get_issue_details` returns the stacktrace for one issue id; the natural-language search tools can be unavailable while the rest works.
- Axiom: `queryDataset` takes APL (`Dataset | where ... | summarize ...`); call `listDatasets` and `getDatasetFields` first for real names. Metrics go through `queryMetrics`, not APL.
- PostHog: one `exec` tool; the `command` parameter's own description carries the syntax. Resolve a person through `persons` before reading recordings.
- Resend: tool names are kebab-case (`list-emails`, not `list_emails`).
- Jam: only useful when the ticket carries a Jam link; `getConsoleLogs` and `getNetworkRequests` beat the video.
- Vercel: query around the time the claim names; check `list_deployments` for a deployment just before the reported window.
- Neon: only when the code path actually uses a Neon database. Never customer data, never memory.

## Billing and Instantly (root tools)

`read_autumn_billing`, `read_stripe_billing`, `list_instantly_subworkspaces`, `read_instantly_subworkspace`, all bare and app-scoped. Call `list_instantly_subworkspaces` first and prefer the selected subworkspace id; `read_instantly_subworkspace` takes `accounts`, `campaigns`, or `emails` and pages with `startingAfter`. They keep their root authorization: available on attended intake-only triage surfaces. `available: false` is an evidence gap, not a reason to retry.

## Fixed evidence reads (root tools)

The same fixed reads Foreman used to produce the evidence, all bare, so a claim is re-checked the way it was made rather than through a hand-written query or filter:

- `lookup_customer`: customer email to the user, live memberships, and `pinnedOrganizationId`; `ambiguous` means several workspaces, `error` means the lookup could not run.
- `describe_table`: a production table's columns from `information_schema`; call it before writing any `planetscale_execute_read_query` against a table you have not seen.
- `read_billing_account`: the organization with `partnerId`, the billing account, wallets, credit balances, and recent credit history; `unavailable` names a list that could not be read.
- `find_related_issues`: `scope: "duplicates"` across every team including closed and archived, or `scope: "masters"` on the Engineering Team; hits carry the phrases that matched.
- `find_help_article`: help-center articles for feature words, with the likely repository path of each article under `apps/web/content/docs` to read from the pinned checkout (derived from the url; a section page is `<path without .mdx>/index.mdx`).
- `find_function_runs`: an Inngest function's newest runs with the given status and the newest run's trace steps; `traceError` means the runs were listed but the trace could not be read. Omit the function id to see matching runs across every function.

## Screenshots (root tool)

`read_image`, bare. Loads a PNG, JPEG, GIF, or WebP from the sandbox into your context, 3 MiB limit.

## Unavailable sources

A user-scoped connection fails with `principal_required` under a service principal, which is normal for Slack intake, and with `task_mode_sign_in_unavailable` when the session's user has not authorized it. You are never shown a sign-in link and never wait for one. A managed connection can fail on operator configuration. Either way: record the lane as unavailable once, decide whether the missing evidence is material, and never ask for authorization, retry the same source, or substitute another for it.
