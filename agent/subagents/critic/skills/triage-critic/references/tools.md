# Critic evidence surface

Company-service tools use Executor. Use `connection_search` with the `connection` argument set to the Executor connection named in this turn's access instructions. Inside `execute`, search one provider namespace with `tools.search({ namespace, query })`, inspect `tools.describe.tool({ path })`, and call the returned `tools[path](input)`. Check `result.ok` before reading `result.data`. The provider tool names below are search hints, not callable Executor addresses. Never guess paths or use a removed direct provider connection. Authored Foreman helpers keep their bare names and require no discovery.

Every source a triage investigation can cite, and how the critic reaches it. Authored helpers reuse root definitions. Company services use the same Foreman Executor toolkit and app credential as root. Critic instructions require read-only review.

## Repository (root tools)

`prepare_repository` then `checkout_commit`, both bare. `glob`, `grep`, and `read_file` read the pinned checkout at `/workspace/repo`. There is no `bash`.

## Production data (root tool)

`planetscale_execute_read_query`, bare. Coordinates, confirmed live: `organization` `acquisity`, `database` `acquisity`, `branch` `main`, and `postgres_database_name` `postgres` (not `acquisity`; passing the wrong one fails with "database does not exist"). Truncates rather than returning unbounded rows; read the `truncated`, `oversizedRow`, `envelopeTooLarge`, and `raw` flags before trusting a result. Read schema through `information_schema.columns` with `postgres_database_name` set; `planetscale_get_branch_schema` is available through Executor for full-schema reads; filter and summarize its result inside Executor before returning it. The PlanetScale surface through Executor also exposes the organization, database, branch, insights, and documentation reads; SQL writes and payment-method changes are excluded by the shared toolkit.

## Investigation memory (root tool)

`search_investigation_memory`, bare. Analogy only, never current truth. `available: false` is normal when the child session carries no memory stamp; record it and move on. It takes no Linear project id.

## Provider and runtime evidence (connections)

| Source | Connection | Auth class | Read boundary |
| --- | --- | --- | --- |
| Linear issues, comments, labels, documents | Executor: linear | app, shared | same Linear access as root; use reads only as required by the critic instructions |
| Intercom conversations and contacts | Executor: intercom | app, shared | root allowlist, reads only |
| Inngest runs, traces, functions | Executor: inngest | app, shared | root allowlist, reads only |
| Lucent issues and insights | Executor: lucent | app, shared | root allowlist, reads only |
| Sentry issues and events | Executor: sentry | app, shared | shared catalog; use issue details and event reads as required by critic instructions |
| Axiom datasets, metrics, monitors | Executor: axiom | app, shared | root allowlist, reads only |
| Vercel projects, deployments and logs | Executor: foreman_vercel_api | app, shared | Foreman-scoped credential; shared catalog; use reads only |
| PostHog persons, recordings, errors, queries | Executor: posthog | app, shared | individual operations discovered through Executor; use reads only |
| Resend emails, logs, domains | Executor: resend | app, shared | root allowlist, reads only |
| Jam recordings, console, network | Executor: jam | app, shared | root allowlist, reads only |
| Modem customer feedback and run reads | Executor: modem | app, shared | shared catalog; discover `search_modem` and `modem_agent_get_run` |
| Neon, only when the code path uses a Neon database | Executor: neon | app, shared | shared catalog; use reads only for review, never as production customer evidence or a substitute for investigation-memory tools |
| Autumn provisioning | Executor: autumn | app, shared | root allowlist, reads only |
| Stripe billing | Executor: stripe | app, shared | root allowlist, reads only |

## Call notes for the connections

- Linear: the Engineering Team id is `8eaf95ab-56ac-4490-8253-f6a96793dc40`; passing the name `"Engineering"` to `list_issues` returns nothing silently. Page with `limit: 250` and the cursor until exhausted.
- Intercom: pass an Intercom URL straight to `fetch`. Free-text search is `search` with a DSL query such as `object_type:conversations q:"campaign stopped sending"`; `search_conversations` filters structured fields only. `search` returns prefixed ids (`contact_<uuid>`) and `contact_ids` wants them raw.
- Inngest: `find_function_runs` with the function id from the code path covers the runs and the newest trace; the connection tools stay for a specific event's runs or an older run's trace.
- Sentry: `get_issue_details` returns the stacktrace for one issue id; the natural-language search tools can be unavailable while the rest works.
- Axiom: `queryDataset` takes APL (`Dataset | where ... | summarize ...`); call `listDatasets` and `getDatasetFields` first for real names. Metrics go through `queryMetrics`, not APL.
- PostHog: discover individual operations such as `persons_list`, `query_trends`, and `execute_sql`, then inspect the selected schema. Resolve a person before reading recordings.
- Resend: discover snake_case operations such as `list_emails`, `get_email`, and `list_logs`.
- Jam: only useful when the ticket carries a Jam link; `getConsoleLogs` and `getNetworkRequests` beat the video.
- Vercel: query around the time the claim names; discover `getDeployments` for a deployment just before the reported window.
- Neon: only when the code path actually uses a Neon database. Never customer data, never memory.

## Billing and Instantly (root tools)

`read_autumn_billing`, `read_stripe_billing`, `list_instantly_subworkspaces`, `read_instantly_subworkspace`, all bare and app-scoped. Call `list_instantly_subworkspaces` first and prefer the selected subworkspace id; `read_instantly_subworkspace` takes `accounts`, `campaigns`, or `emails` and pages with `startingAfter`. They retain their input validation and bounded result handling. `available: false` is an evidence gap, not a reason to retry.

## Fixed evidence reads (root tools)

The same fixed reads Foreman used to produce the evidence, all bare, so a claim is re-checked the way it was made rather than through a hand-written query or filter:

- `lookup_customer`: customer email to the user, live memberships, and `pinnedOrganizationId`; `ambiguous` means several workspaces, `error` means the lookup could not run. The pin scopes PlanetScale only: Autumn is keyed by `billingAccount.id` from `read_billing_account`, and Stripe by that record's `stripe_id`. An Autumn 404 in a report under review is a wrong id, not an outage, unless `organization.partnerGoverned` is true: a partner-governed account has no customer in Acquisity's own Autumn.
- `describe_table`: a production table's columns from `information_schema`; call it before writing any `planetscale_execute_read_query` against a table you have not seen.
- `read_billing_account`: the organization with `partnerId` and `partnerGoverned` (the default partner id `00000000-0000-0000-0000-000000000001` is native, not a partner), the billing account, wallets, credit balances, and recent credit history; `unavailable` names a list that could not be read.
- `find_related_issues`: `scope: "duplicates"` across every team including closed and archived, or `scope: "masters"` on the Engineering Team; hits carry the phrases that matched.
- `find_help_article`: help-center articles for feature words, with the likely repository path of each article under `apps/web/content/docs` to read from the pinned checkout (derived from the url; a section page is `<path without .mdx>/index.mdx`).
- `find_function_runs`: an Inngest function's newest runs with the given status and the newest run's trace steps; `traceError` means the runs were listed but the trace could not be read. Omit the function id to see matching runs across every function.

## Screenshots (root tool)

`read_image`, bare. Loads a PNG, JPEG, GIF, or WebP from the sandbox into your context, 3 MiB limit.

## Unavailable sources

Company evidence uses the shared app-scoped Foreman Executor connection. A missing connector, unavailable binding, or denied provider is an unavailable source for this review, not a request for the ticket requester to sign in. Record it once, decide whether the missing evidence is material, and continue without retrying or substituting another source.
