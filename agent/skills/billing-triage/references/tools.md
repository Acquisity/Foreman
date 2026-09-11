# Billing investigation tools

Company-service tools use Executor. Use `connection_search` with the `connection` argument set to the Executor connection named in this turn's access instructions. Inside `execute`, search one provider namespace with `tools.search({ namespace, query })`, inspect `tools.describe.tool({ path })`, and call the returned `tools[path](input)`. Check `result.ok` before reading `result.data`. The provider tool names below are search hints, not callable Executor addresses. Never guess paths or use a removed direct provider connection. Authored Foreman helpers keep their bare names and require no discovery.

Never guess a tool name. A service's REST API, its CLI, and its MCP server rarely share naming, and an invented call fails in a way that reads like the customer has no data.

## How tool names work

Call authored root tools by their bare names; call company provider tools by the Executor paths discovered above.

**Root tools** are authored in `agent/tools/` or provided by the eve framework. They are called by their bare name with no prefix: `prepare_repository`, `grep`, `glob`, `read_file`, `bash`, `lookup_customer`, `read_billing_account`, `describe_table`, `save_investigation_document`, `route_ticket`, `planetscale_execute_read_query`.

`planetscale_execute_read_query` is an authored helper, called bare. Executor also exposes the provider operation of the same name, which does not apply the helper's result bounds. Prefer the bare helper for bounded production queries.

Read them in flow order: PlanetScale, then Autumn, then Stripe. The app-scoped root tools `read_autumn_billing` and `read_stripe_billing` run on every surface through the shared Executor connection; the approved provider MCP reads through Executor cover questions beyond a successful helper result. They share the helper's provider access, so do not retry an unavailable or denied source through another tool this turn. The billing skill separately permits one discovered read after a named local binding failure before dispatch. A 404 is an identity finding: re-resolve the id as the billing skill directs, rather than repeating the same lookup through another tool.

## PlanetScale (Executor: planetscale)

`lookup_customer` is the identity gate: one fixed production query from a customer email to the user, live memberships, and `pinnedOrganizationId`. It is a root tool, called bare. Use it instead of writing the identity join yourself.

`read_billing_account` is the system-of-record read: one root tool, called bare, with the organization, partner, billing account, wallets, credit balances, and recent credit history in fixed queries. `planetscale_execute_read_query` stays for the rows it does not cover, such as `domain_purchase_order` and invoice rows; prefer the authored tool in `agent/tools/` for its truncation and result bounds. The provider operation of the same name is also discoverable through Executor.

On `planetscale_execute_read_query`, check the result flags before trusting rows: `truncated` means rows are missing, `oversizedRow` means a single row exceeded the cap so select fewer columns, `envelopeTooLarge` means oversized server metadata, and `raw` means the result could not be parsed. A refund amount computed from a truncated result is wrong.

Scope every query to the organization pinned by the identity gate. Nothing binds it for you. Unsure of a table or column name: call `describe_table` first, a root tool called bare; do not guess names into a query.

Also allowlisted, from the connection: `planetscale_list_organizations`, `planetscale_get_organization`, `planetscale_list_databases`, `planetscale_get_database`, `planetscale_list_branches`, `planetscale_get_branch`, `planetscale_get_insights`, `planetscale_list_schema_recommendations`, `planetscale_search_documentation`. Additional reads, including full schema and documentation, are discoverable through Executor; this list is not exhaustive. SQL writes and payment-method changes are excluded.

Connection coordinates, confirmed live: organization `acquisity`, database `acquisity`, branch `main`, and `postgres_database_name` is `postgres`.

## Instantly (root tools, no prefix)

`list_instantly_subworkspaces`, `read_instantly_subworkspace`.

Use these only when the financial ask also turns on Instantly provisioning or live provider state. Find provider workspaces with `list_instantly_subworkspaces({ search: "customer name fragment" })`; an internal ID is not needed. It validates up to 100 Workspace Group pages before returning any matches; a source page-cap error means incomplete membership evidence. Results are bounded by `limit` (default 20, maximum 100) and 256 KiB, with `totalMatches`, `totalAcceptedSubworkspaces`, and `nextStartingAfter`. Continue discovery with the same search and returned cursor until null when reviewing more candidates. `membershipComplete` describes internal validation, not an exhaustive public page. Select the evidence-backed match and use its returned ID with `read_instantly_subworkspace`, which independently validates the complete membership set; never guess between ambiguous candidates. No exact name match proves only an unresolved selector, not absent provisioning; do not equate the product workspace display name with the provider workspace identity. Only when an accepted selection exists and resource evidence is relevant, prefer its ID and call `read_instantly_subworkspace` for one bounded `accounts`, `campaigns`, or `emails` page. Pass each returned `nextStartingAfter` value back as `startingAfter` until it is null. Every page identifies the source workspace name and ID. Every resource uses an explicit investigative-field allowlist; email reads are preview-only and omit bodies, attachment payloads, and all provider address representations.

The tools use an app-scoped IBG credential, require no requester OAuth, and expose only fixed GET routes. They can prove provider state but cannot prove payment, entitlement, or refund amount. `available: false` is `Could not run`, never an empty account and never a prompt for the Slack requester to sign in. No tool can invite or remove a workspace, change an account or campaign, send an email, reply, forward, pause, resume, or call an arbitrary path.

## Autumn (Executor: autumn)

Use the root tool `read_autumn_billing` first, on every surface. Pass `billingAccount.id` from `read_billing_account`: Acquisity keys Autumn customers by billing account id, and the organization id answers `customer_not_found`. A 404 reason is a wrong id, never an outage or an empty account; re-resolve before recording anything. The one expected 404 is a partner-governed organization, `organization.partnerGoverned` true, which is on Whop and has no customer in Acquisity's own Autumn; that is the partner rule, not an id problem. The record's `stripe_id` is the `cus_` id Stripe needs. Its only provider call is Autumn's `customers.get` read route with plans and balances expanded; it cannot create a missing customer or call a write route. `available: false` means `Could not run`, never an empty account.

The Autumn MCP reads below are available through the shared company Executor toolkit when the root tool answers `available: false`. They require no requester provider login.

`getCustomer`, keyed by the same billing account id, for this customer's plan, add-ons, active subscriptions, and feature balances. `getPlan` and `listPlans` for the catalog behind them. `listFeatures` for what a feature id means. `getEntity` and `listEntities` for per-entity balances. `listCustomers` finds a customer id and `getCurrentOrganization` identifies the org the token is scoped to.

Also available: date utilities, reward listing, agent-rule reads, event aggregation, request-log reads, and non-mutating previews. Discover the installed lower-case paths and inspect their schemas; the names above are search hints, not an exhaustive catalog.

An unavailable Executor connection or denied provider read is `Could not run`, not an empty result: never read it as the customer having no Autumn account or ask the ticket requester to sign in.

The server also exposes write tools that attach a plan, create a balance, grant a reward, or update a subscription. None are allowlisted, and the connection's OAuth grant carries no write scope, so none can move money or grant entitlement from here regardless of what a ticket asks for. This skill proposes; a human executes.

`getOrCreateCustomer` reads like a getter and creates on a miss, so it is excluded as a write. The `preview*` operations are available because they compute without applying a mutation. Use them only when needed to explain a proposed change; billing mutations remain excluded.

Line items for domains and inboxes are both named generically. The identifier is in the metadata, shaped `xxxxxxxxx{domain.co}`. Read metadata on every line item before counting or matching.

## Stripe (Executor: stripe)

Use the root tool `read_stripe_billing` first, on every surface. Its `customer` lookup takes the `cus_` id from the Autumn record's `stripe_id` and reads at most 20 recent subscriptions, invoices, charges, credit notes, and customer balance transactions alongside the customer. Use `charge` to read a known charge and its attached refund history, or `refund` and `dispute` for known object ids. Its `promotion_code` lookup finds an exact customer-facing code, and `coupon` reads a known coupon id. A per-section error means that section is unverified; keep the successful sections without asserting why the failed read failed. When a returned list says `has_more: true`, its history is incomplete. Do not make an amount or refund verdict until the exact relevant object is read. The tool has fixed GET routes and cannot write.

The Stripe MCP reads below are available through the shared company Executor toolkit when the root tool answers `available: false`. They require no requester provider login.

`stripe_api_read` for a known object, `stripe_api_search` to find one, `stripe_api_details` when a call shape is unclear. `search_stripe_documentation` for API semantics. `list_available_accounts_or_orgs` for account context.

The toolkit excludes `stripe_api_write` and account-management writes. The authored Stripe helper also exposes only fixed reads. Propose any refund for a human to execute; never invent a `create_refund` tool.

Amounts are in the smallest currency unit. A charge of `7200` is $72.00. Read `amount_refunded` on each charge rather than assuming a charge is unrefunded, and read the customer balance and any credit notes before proposing a credit, since a prior ticket may already have covered the same charge.

Docs: <https://docs.stripe.com/mcp>.

## Linear (Executor: linear)

`get_issue`, `list_comments`, `save_comment`, `save_issue`, `save_document`.

`save_investigation_document` is a root tool, called bare: it owns the ticket's `Billing investigation` document, creating it once and rewriting it after, and refuses card or bank account numbers. Do not write that document through `save_document`.

`route_ticket` is a root tool, called bare: the final routing write. It adds labels to the ticket's existing set (unknown names fail and list the valid ones), resolves state, project, and assignee by name, inherits an assignee from a master or parent, records a duplicate relation, attaches links, and reads the ticket back with the saved `projectId`. Use it for every routing write in these skills; `save_issue` stays for creating issues and for description edits. `save_issue`'s `labels` field replaces the whole set, which is why routing does not go through it.

## Repository (root tools, no prefix)

`prepare_repository` with `Acquisity/Acquisity`, then `grep` and `read_file` under the returned `worktree`. Only when the three systems diverge and the readouts do not explain why.
