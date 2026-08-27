# Billing investigation tools

Exact tool names for the systems of record. Every name below was read from this repository's `tools.allow` list in `agent/connections/<name>.ts`, from the tool's own definition in `agent/tools/`, or from eve's own built-in tool surface.

Never guess a tool name. A service's REST API, its CLI, and its MCP server rarely share naming, and an invented call fails in a way that reads like the customer has no data.

## How tool names work

Two kinds of tool appear below, and they are called differently.

**Connection tools** live on an MCP server wired up in `agent/connections/`. The model calls them by their qualified name, `<connection>__<tool>`, where the connection name is the filename: `linear__list_issues`, `inngest__get_run_trace`, `planetscale__planetscale_list_databases`. The bare names listed under each heading below are the server-side names as they appear in that connection's `tools.allow`; prefix them with the heading's connection name when you call one.

**Root tools** are authored in `agent/tools/` or provided by the eve framework. They are called by their bare name with no prefix: `prepare_repository`, `grep`, `glob`, `read_file`, `bash`, `lookup_customer`, `planetscale_execute_read_query`.

`planetscale_execute_read_query` is the trap: it is a root tool, called bare, and it shadows a connection tool of the same name that is deliberately excluded from the allowlist. Never call it as `planetscale__planetscale_execute_read_query`.

Use the built-in `connection_search` to discover what a connection actually exposes. When a tool you want is not listed here, search before calling. If you cannot, record the lane as `Could not run` rather than trying names until one sticks.

Read them in flow order: PlanetScale, then Autumn, then Stripe. Every configured intake-only channel uses the app-scoped root tools described below. Other attended surfaces keep the broader user-scoped MCP tools.

## PlanetScale (`planetscale__`)

`lookup_customer` is the identity gate: one fixed production query from a customer email to the user, live memberships, and `pinnedOrganizationId`. It is a root tool, called bare. Use it instead of writing the identity join yourself.

`planetscale_execute_read_query`, an authored tool in `agent/tools/`, not the MCP tool of the same name. The MCP original is excluded from the allowlist because it returns rows unbounded; the authored wrapper truncates.

Check the result flags before trusting rows: `truncated` means rows are missing, `oversizedRow` means a single row exceeded the cap so select fewer columns, `envelopeTooLarge` means oversized server metadata, and `raw` means the result could not be parsed. A refund amount computed from a truncated result is wrong.

Scope every query to the organization pinned by the identity gate. Nothing binds it for you.

Also allowlisted, from the connection: `planetscale_list_organizations`, `planetscale_get_organization`, `planetscale_list_databases`, `planetscale_get_database`, `planetscale_list_branches`, `planetscale_get_branch`, `planetscale_get_insights`, `planetscale_list_schema_recommendations`, `planetscale_search_documentation`. That is the whole surface; there is no write tool to reach even by accident.

Connection coordinates, confirmed live: organization `acquisity`, database `acquisity`, branch `main`, and `postgres_database_name` is `postgres`.

## Instantly (root tools, no prefix)

`list_instantly_subworkspaces`, `read_instantly_subworkspace`.

Use these only when the financial ask also turns on Instantly provisioning or live provider state. Call `list_instantly_subworkspaces` first and use its result alone for membership evidence. It follows up to 100 Workspace Group pages; treat a cap error as `Could not run` and incomplete evidence. Only when an accepted selection exists and resource evidence is relevant, prefer its ID and call `read_instantly_subworkspace` for one bounded `accounts`, `campaigns`, or `emails` page. Pass each returned `nextStartingAfter` value back as `startingAfter` until it is null. Every page identifies the source workspace name and ID. Every resource uses an explicit investigative-field allowlist; email reads are preview-only and omit bodies, attachment payloads, and all provider address representations.

The tools use an app-scoped IBG credential, require no requester OAuth, and expose only fixed GET routes. They can prove provider state but cannot prove payment, entitlement, or refund amount. `available: false` is `Could not run`, never an empty account and never a prompt for the Slack requester to sign in. No tool can invite or remove a workspace, change an account or campaign, send an email, reply, forward, pause, resume, or call an arbitrary path.

## Autumn (`autumn__`)

In any configured intake-only channel, use the root tool `read_autumn_billing` instead. Pass only the existing customer or organization id already verified in PlanetScale. Its only provider call is Autumn's `customers.get` read route with plans and balances expanded; it cannot create a missing customer or call a write route. `available: false` means `Could not run`, never an empty account.

The `autumn__` connection below is for attended users who have personally connected Autumn.

`getCustomer` for this customer's plan, add-ons, active subscriptions, and feature balances. `getPlan` and `listPlans` for the catalog behind them. `listFeatures` for what a feature id means. `getEntity` and `listEntities` for per-entity balances. `listCustomers` finds a customer id and `getCurrentOrganization` identifies the org the token is scoped to.

Also allowlisted: `dateToEpochMilliseconds`, `epochMillisecondsToDate`. That is the whole surface.

The MCP connection is user-scoped, so a teammate who has never consented gets a sign-in failure rather than data. That is `Could not run`, not an empty result: never read it as the customer having no Autumn account.

The server also exposes write tools that attach a plan, create a balance, grant a reward, or update a subscription. None are allowlisted, and the connection's OAuth grant carries no write scope, so none can move money or grant entitlement from here regardless of what a ticket asks for. This skill proposes; a human executes.

`getOrCreateCustomer` reads like a getter and creates on a miss, so it is excluded as a write. The `preview*` tools are excluded too: they compute without applying, but each one stages an attach, a balance grant, a catalog change, or a subscription update.

Line items for domains and inboxes are both named generically. The identifier is in the metadata, shaped `xxxxxxxxx{domain.co}`. Read metadata on every line item before counting or matching.

## Stripe (`stripe__`)

In any configured intake-only channel, use the root tool `read_stripe_billing` instead. Its `customer` lookup reads at most 20 recent subscriptions, invoices, charges, credit notes, and customer balance transactions alongside the customer. Use `charge` to read a known charge and its attached refund history, or `refund` and `dispute` for known object ids. Its `promotion_code` lookup finds an exact customer-facing code, and `coupon` reads a known coupon id. A per-section error means that section is unverified; keep the successful sections without asserting why the failed read failed. When a returned list says `has_more: true`, its history is incomplete. Do not make an amount or refund verdict until the exact relevant object is read. The tool has fixed GET routes and cannot write.

The `stripe__` connection below is for attended users who have personally connected Stripe.

`stripe_api_read` for a known object, `stripe_api_search` to find one, `stripe_api_details` when a call shape is unclear. `search_stripe_documentation` for API semantics. `get_stripe_account_info` and `list_available_accounts_or_orgs` for account context.

`stripe_api_write` and `create_refund` exist on the server and are excluded from this connection's allowlist, so no tool reachable here can move money regardless of what a ticket asks for.

Amounts are in the smallest currency unit. A charge of `7200` is $72.00. Read `amount_refunded` on each charge rather than assuming a charge is unrefunded, and read the customer balance and any credit notes before proposing a credit, since a prior ticket may already have covered the same charge.

Docs: <https://docs.stripe.com/mcp>.

## Linear (`linear__`)

`get_issue`, `list_comments`, `save_comment`, `save_issue`, `save_document`.

`save_document` takes exactly one parent; pass `issue` for the issue-scoped `Billing investigation` document. Use `patch` to update an existing one rather than creating a second.

`save_issue` traps: `labels` replaces the entire label set, so read current labels and pass the union. `priority` is a number, 1 Urgent through 4 Low.

## Repository (root tools, no prefix)

`prepare_repository` with `Acquisity/Acquisity`, then `grep` and `read_file` under the returned `worktree`. Only when the three systems diverge and the readouts do not explain why.
