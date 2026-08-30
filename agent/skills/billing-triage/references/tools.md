# Billing investigation tools

Exact tool names for the systems of record. Every name below was read from this repository's `tools.allow` list in `agent/connections/<name>.ts`, from the tool's own definition in `agent/tools/`, or from eve's own built-in tool surface.

Never guess a tool name. A service's REST API, its CLI, and its MCP server rarely share naming, and an invented call fails in a way that reads like the customer has no data.

## How tool names work

Two kinds of tool appear below, and they are called differently.

**Connection tools** live on an MCP server wired up in `agent/connections/`. The model calls them by their qualified name, `<connection>__<tool>`, where the connection name is the filename: `linear__list_issues`, `inngest__get_run_trace`, `planetscale__planetscale_list_databases`. The bare names listed under each heading below are the server-side names as they appear in that connection's `tools.allow`; prefix them with the heading's connection name when you call one.

**Root tools** are authored in `agent/tools/` or provided by the eve framework. They are called by their bare name with no prefix: `prepare_repository`, `grep`, `glob`, `read_file`, `bash`, `lookup_customer`, `read_billing_account`, `describe_table`, `save_investigation_document`, `route_ticket`, `planetscale_execute_read_query`.

`planetscale_execute_read_query` is the trap: it is a root tool, called bare, and it shadows a connection tool of the same name that is deliberately excluded from the allowlist. Never call it as `planetscale__planetscale_execute_read_query`.

Use the built-in `connection_search` with the `connection` argument naming one connection to discover what it actually exposes; never search without it, because that queries every connection at once. When a tool you want is not listed here, search before calling. If you cannot, record the lane as `Could not run` rather than trying names until one sticks.

Read them in flow order: PlanetScale, then Autumn, then Stripe. The app-scoped root tools `read_autumn_billing` and `read_stripe_billing` run on every surface except an untrusted GitHub session; the user-scoped MCP tools are the fallback when a root tool could not run. A 404 reason is not that case: it is a wrong id, and a fallback with the same id fails the same way.

## PlanetScale (`planetscale__`)

`lookup_customer` is the identity gate: one fixed production query from a customer email to the user, live memberships, and `pinnedOrganizationId`. It is a root tool, called bare. Use it instead of writing the identity join yourself.

`read_billing_account` is the system-of-record read: one root tool, called bare, with the organization, partner, billing account, wallets, credit balances, and recent credit history in fixed queries. `planetscale_execute_read_query` stays for the rows it does not cover, such as `domain_purchase_order` and invoice rows; it is an authored tool in `agent/tools/`, not the MCP tool of the same name, which is excluded from the allowlist because it returns rows unbounded; the authored wrapper truncates.

On `planetscale_execute_read_query`, check the result flags before trusting rows: `truncated` means rows are missing, `oversizedRow` means a single row exceeded the cap so select fewer columns, `envelopeTooLarge` means oversized server metadata, and `raw` means the result could not be parsed. A refund amount computed from a truncated result is wrong.

Scope every query to the organization pinned by the identity gate. Nothing binds it for you. Unsure of a table or column name: call `describe_table` first, a root tool called bare; do not guess names into a query.

Also allowlisted, from the connection: `planetscale_list_organizations`, `planetscale_get_organization`, `planetscale_list_databases`, `planetscale_get_database`, `planetscale_list_branches`, `planetscale_get_branch`, `planetscale_get_insights`, `planetscale_list_schema_recommendations`, `planetscale_search_documentation`. That is the whole surface; there is no write tool to reach even by accident.

Connection coordinates, confirmed live: organization `acquisity`, database `acquisity`, branch `main`, and `postgres_database_name` is `postgres`.

## Instantly (root tools, no prefix)

`list_instantly_subworkspaces`, `read_instantly_subworkspace`.

Use these only when the financial ask also turns on Instantly provisioning or live provider state. Call `list_instantly_subworkspaces` first and use its result alone for membership evidence. It follows up to 100 Workspace Group pages; treat a cap error as `Could not run` and incomplete evidence. Only when an accepted selection exists and resource evidence is relevant, prefer its ID and call `read_instantly_subworkspace` for one bounded `accounts`, `campaigns`, or `emails` page. Pass each returned `nextStartingAfter` value back as `startingAfter` until it is null. Every page identifies the source workspace name and ID. Every resource uses an explicit investigative-field allowlist; email reads are preview-only and omit bodies, attachment payloads, and all provider address representations.

The tools use an app-scoped IBG credential, require no requester OAuth, and expose only fixed GET routes. They can prove provider state but cannot prove payment, entitlement, or refund amount. `available: false` is `Could not run`, never an empty account and never a prompt for the Slack requester to sign in. No tool can invite or remove a workspace, change an account or campaign, send an email, reply, forward, pause, resume, or call an arbitrary path.

## Autumn (`autumn__`)

Use the root tool `read_autumn_billing` first, on every surface. Pass `billingAccount.id` from `read_billing_account`: Acquisity keys Autumn customers by billing account id, and the organization id answers `customer_not_found`. A 404 reason is a wrong id, never an outage or an empty account; re-resolve before recording anything. The one expected 404 is a partner-governed organization, `organization.partnerGoverned` true, which is on Whop and has no customer in Acquisity's own Autumn; that is the partner rule, not an id problem. The record's `stripe_id` is the `cus_` id Stripe needs. Its only provider call is Autumn's `customers.get` read route with plans and balances expanded; it cannot create a missing customer or call a write route. `available: false` means `Could not run`, never an empty account.

The `autumn__` connection below is the fallback when the root tool answers `available: false`, for users who have personally connected Autumn.

`getCustomer`, keyed by the same billing account id, for this customer's plan, add-ons, active subscriptions, and feature balances. `getPlan` and `listPlans` for the catalog behind them. `listFeatures` for what a feature id means. `getEntity` and `listEntities` for per-entity balances. `listCustomers` finds a customer id and `getCurrentOrganization` identifies the org the token is scoped to.

Also allowlisted: `dateToEpochMilliseconds`, `epochMillisecondsToDate`. That is the whole surface.

The MCP connection is user-scoped, so a teammate who has never consented gets a sign-in failure rather than data. That is `Could not run`, not an empty result: never read it as the customer having no Autumn account.

The server also exposes write tools that attach a plan, create a balance, grant a reward, or update a subscription. None are allowlisted, and the connection's OAuth grant carries no write scope, so none can move money or grant entitlement from here regardless of what a ticket asks for. This skill proposes; a human executes.

`getOrCreateCustomer` reads like a getter and creates on a miss, so it is excluded as a write. The `preview*` tools are excluded too: they compute without applying, but each one stages an attach, a balance grant, a catalog change, or a subscription update.

Line items for domains and inboxes are both named generically. The identifier is in the metadata, shaped `xxxxxxxxx{domain.co}`. Read metadata on every line item before counting or matching.

## Stripe (`stripe__`)

Use the root tool `read_stripe_billing` first, on every surface. Its `customer` lookup takes the `cus_` id from the Autumn record's `stripe_id` and reads at most 20 recent subscriptions, invoices, charges, credit notes, and customer balance transactions alongside the customer. Use `charge` to read a known charge and its attached refund history, or `refund` and `dispute` for known object ids. Its `promotion_code` lookup finds an exact customer-facing code, and `coupon` reads a known coupon id. A per-section error means that section is unverified; keep the successful sections without asserting why the failed read failed. When a returned list says `has_more: true`, its history is incomplete. Do not make an amount or refund verdict until the exact relevant object is read. The tool has fixed GET routes and cannot write.

The `stripe__` connection below is the fallback when the root tool answers `available: false`, for users who have personally connected Stripe.

`stripe_api_read` for a known object, `stripe_api_search` to find one, `stripe_api_details` when a call shape is unclear. `search_stripe_documentation` for API semantics. `get_stripe_account_info` and `list_available_accounts_or_orgs` for account context.

`stripe_api_write` and `create_refund` exist on the server and are excluded from this connection's allowlist, so no tool reachable here can move money regardless of what a ticket asks for.

Amounts are in the smallest currency unit. A charge of `7200` is $72.00. Read `amount_refunded` on each charge rather than assuming a charge is unrefunded, and read the customer balance and any credit notes before proposing a credit, since a prior ticket may already have covered the same charge.

Docs: <https://docs.stripe.com/mcp>.

## Linear (`linear__`)

`get_issue`, `list_comments`, `save_comment`, `save_issue`, `save_document`.

`save_investigation_document` is a root tool, called bare: it owns the ticket's `Billing investigation` document, creating it once and rewriting it after, and refuses card or bank account numbers. Do not write that document through `save_document`.

`route_ticket` is a root tool, called bare: the final routing write. It adds labels to the ticket's existing set (unknown names fail and list the valid ones), resolves state, project, and assignee by name, inherits an assignee from a master or parent, records a duplicate relation, attaches links, and reads the ticket back with the saved `projectId`. Use it for every routing write in these skills; `save_issue` stays for creating issues and for description edits. `save_issue`'s `labels` field replaces the whole set, which is why routing does not go through it.

## Repository (root tools, no prefix)

`prepare_repository` with `Acquisity/Acquisity`, then `grep` and `read_file` under the returned `worktree`. Only when the three systems diverge and the readouts do not explain why.
