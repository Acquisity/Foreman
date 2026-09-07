# Foreman Executor deployment contract

Foreman now routes company MCPs and the fourteen authored provider tools through Executor. Provider setup is separate from enabling these calls: the Vercel connector, full profile toolkits, and exact helper bindings must exist before deploying this revision. Supermemory remains a personal direct connection. No automatic direct-provider fallback exists.

## Accounts and profiles

Use the existing connected company accounts for authorized Acquisity investigations, irrespective of the ticket requester. The Foreman-to-Executor credential is app-scoped in Vercel Connect. Executor 1.6.8 personal API keys still act as their owning Executor account; choosing app scope in Vercel does not change that ownership. Keep personal Supermemory out of this shared account surface.

`pnpm executor:contract` emits the required toolkit URLs, retained upstream tool lists, and all helper operation identifiers without reading credentials or contacting Executor. Resolve those upstream names to the actual catalog addresses; do not generate lowercased or guessed paths. The captured provider lists preserve the source catalogs from Foreman 119bb01, including the narrower critic lists and existing attended Vercel/OpenRouter actions. Wildcards retain the original provider-side read grant, not permission to broaden consent.

Eve 0.44 requires static connection URLs. Both root and critic therefore mount five connection slots: `executor`, `executor-limited`, `executor-factory`, `executor-scheduled`, and `executor-scheduled-internal`. Runtime auth and approval gates admit exactly the profile selected from channel-owned stamps. The prompt names that active connection each turn. The critic uses separate `foreman-critic-*` endpoints. No slot admits MCP `resume` or artifact/management tools.

- `attended`: trusted or investigation-authorized interactive work. Preserve existing allowed writes.
- `limited`: sessions without operational authority. Do not grant them shared personal-service access. Retain Exa and the existing Inngest, Linear, Lucent, and PlanetScale app surfaces; Intercom remains unavailable.
- `factory`: explicitly authorized autonomous factory work. No Linear calls or attended-only provider writes; preserve Intercom factory reads.
- `scheduled`: unattended, without internal trust. Linear allows only `list_issues` and `get_issue`; Intercom is unavailable; no provider writes.
- `scheduled-internal`: the same scheduled restrictions, with the existing trusted Intercom read allowance.

Configure these rules in each toolkit's actual invocation policy, including nested calls through `execute`; discovery filtering alone is insufficient. Do not assume workspace policies are automatically added to toolkit policies. Test guessed denied operations as well as visible tools. Exclude raw PlanetScale query/full-schema tools and all helper-only APIs from model toolkits. Bind root/critic/profile identity to MCP sessions and reject cross-profile reuse. The internal helper client starts a fresh session per invocation and never resumes an approval.

## Exact helper bindings

Set `EXECUTOR_OPERATION_BINDINGS` to JSON keyed by the operation identifiers emitted by the contract report. Each entry has `path`, the exact installed path returned by `tools.search`/`tools.describe.tool`, and `arguments`, a map from destination argument fields to source fields. Dotted destination fields build nested input objects. Source roots are `body`, `query`, `path`, and `headers`; PlanetScale uses `args`.

For example, if a verified customer tool accepts `{path: {customer: string}}`, its binding maps `"path.customer": "path.id"`. This describes argument mapping only; obtain the actual tool path from Executor. A binding is never supplied by the model. Missing, malformed, management, or unknown bindings fail without calling a provider. Query parameters retain the request's string representation, including array values for repeated parameters; verify these against the installed operation schema when authoring mappings.

The fixed source descriptors include:

- Autumn customer reads: `body.customer_id`, `body.expand`, and `headers.x-api-version` (2.3.0).
- Stripe: `path.id` for object reads; `query` for bounded lists and expansions.
- Instantly: `query`, plus `headers.x-as-workspace` only after the helper verifies complete group membership.
- Inngest: `path.appId`, `path.functionId`, `path.runId`, and `query` for app/run/trace operations.
- Linear: `body.query` and `body.variables` for thirteen fixed named GraphQL operations. A generic GraphQL integration, if used internally, must not be exposed through a model toolkit. Document creation/update and routing retain their existing authored guards.
- Help-center search: `query.query` for Acquisity's `/api/search`.
- PlanetScale: the complete authored query arguments in `args`, mapped to the verified MCP operation's individual fields.

Helper traffic uses the five `foreman-helpers-*` toolkit endpoints. Those endpoints are private to authored code, not Eve connections. Grant only the operations needed by that profile and preserve the provider read-only grants. The client invokes one fixed bound operation using JSON-quoted arguments, unwraps Executor's `structuredContent.result` success/error union, and reconstructs the provider response for the existing helper validation and filters. It forwards only the explicitly selected API-version and workspace headers into arguments, never provider credentials.

## Operations

Foreman lifecycle logs continue to record only the outer tool and connection names, outcome, session id, and turn id. Executor calls therefore appear under their `executor` profile connection; authored helpers keep their existing tool names. Use Executor invocation records to diagnose the underlying provider. Do not derive provider names by parsing generated code or log tool arguments, results, credentials, or provider error bodies.

## Provisioning and verification

1. Inspect `pnpm executor:contract` against the installed Executor 1.6.8 catalog. Verify every required helper operation, argument schema, provider account, and response envelope. Registered integrations alone do not prove those operations exist. Add any missing operation to the existing appropriate integration before binding it.
2. Create the required constrained toolkits and hard-denial policies. Preserve existing attended write access, superseding the earlier only-Linear-writes setup notes. Keep unknown tools and Executor administration blocked.
3. Create an API-key Vercel connector, attach it to Foreman preview, and set `EXECUTOR_MCP_CONNECTOR` to its actual UID. Store the key in Connect, not the environment. Set `EXECUTOR_BASE_URL` to an HTTPS origin and install the verified binding JSON. `LINEAR_CONNECTOR` remains required for inbound Agent Sessions and vision attachment reads; GitHub, Slack, storage, and runtime credentials stay separate.
4. Run `pnpm validate`, `pnpm report:capabilities`, and preview direct/factory sessions. Check triage initiated by a different requester, critic restrictions, schedules, permitted attended writes, nested guessed denials, missing credentials, cancellation, and bounded results. Use a scratch repository for a full-pipeline eval; do not exercise production writes merely to test authorization.
5. Switch production only after preview passes. Roll back by redeploying the prior revision with its previous configuration. Retire the migrated outbound connector attachments only after the observation period; keep inbound/attachment credentials and personal Supermemory.

No connector or toolkit was provisioned and no live traffic was switched by the code migration. Live policy enforcement, installed operation bindings, and end-to-end preview remain release requirements, not claims made by unit tests.
