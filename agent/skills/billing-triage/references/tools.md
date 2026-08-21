# Billing investigation tools

Exact tool names for the systems of record. Every name below was read from this repository's `tools.allow` list in `agent/connections/<name>.ts`, or from the tool's own definition in `agent/tools/`, except where a vendor doc is linked.

Never guess a tool name. A service's REST API, its CLI, and its MCP server rarely share naming, and an invented call fails in a way that reads like the customer has no data.

## How tool names work

Two kinds of tool appear below, and they are called differently.

**Connection tools** live on an MCP server wired up in `agent/connections/`. The model calls them by their qualified name, `<connection>__<tool>`, where the connection name is the filename: `linear__list_issues`, `inngest__get_run_trace`, `planetscale__planetscale_list_databases`. The bare names listed under each heading below are the server-side names as they appear in that connection's `tools.allow`; prefix them with the heading's connection name when you call one.

**Root tools** are authored in `agent/tools/` or provided by the eve framework. They are called by their bare name with no prefix: `prepare_repository`, `grep`, `glob`, `read_file`, `bash`, `planetscale_execute_read_query`.

`planetscale_execute_read_query` is the trap: it is a root tool, called bare, and it shadows a connection tool of the same name that is deliberately excluded from the allowlist. Never call it as `planetscale__planetscale_execute_read_query`.

Use the built-in `connection_search` to discover what a connection actually exposes. When a tool you want is not listed here, search before calling. If you cannot, record the lane as `Could not run` rather than trying names until one sticks.

Read them in flow order: PlanetScale, then Autumn, then Stripe.

## PlanetScale (`planetscale__`)

`planetscale_execute_read_query`, an authored tool in `agent/tools/`, not the MCP tool of the same name. The MCP original is excluded from the allowlist because it returns rows unbounded; the authored wrapper truncates.

Check the result flags before trusting rows: `truncated` means rows are missing, `oversizedRow` means a single row exceeded the cap so select fewer columns, `envelopeTooLarge` means oversized server metadata, and `raw` means the result could not be parsed. A refund amount computed from a truncated result is wrong.

Scope every query to the organization pinned by the identity gate. Nothing binds it for you.

## Autumn (`autumn__`)

`getCustomer` for this customer's plan, add-ons, active subscriptions, and feature balances. `getPlan` and `listPlans` for the catalog behind them. `listFeatures` for what a feature id means. `getEntity` and `listEntities` for per-entity balances.

Line items for domains and inboxes are both named generically. The identifier is in the metadata, shaped `xxxxxxxxx{domain.co}`. Read metadata on every line item before counting or matching.

Write tools exist on this server and are out of scope here: anything that attaches a plan, creates a balance, or updates a subscription moves money or grants entitlement. This skill proposes; a human executes.

## Stripe (`stripe__`)

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
