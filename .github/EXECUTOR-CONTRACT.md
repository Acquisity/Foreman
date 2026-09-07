# Foreman Executor connection

Foreman uses one shared company toolkit, `Foreman`, at `https://executor.acquisity.ai/mcp/toolkits/foreman?artifacts=false`. Root, critic, factory work, schedules, and authored provider helpers use the same endpoint and company accounts. New workflows do not need new toolkits.

## What controls behavior

Skills and agent instructions define the workflow. Critic instructions require read-only review even though it shares the same connection. Linear writes and OpenRouter requests are available. Vercel deployments and toolbar actions are intended capabilities once its downstream connection is installed. Resend retains the selected read operations. Provider credentials and their existing scopes stay in Executor. Autumn includes all 18 read-only API operations and all 20 MCP reads, date utilities, and non-mutating previews in the installed catalog. Customer, subscription, balance, plan, catalog, and organization-rule mutations remain excluded from the read-only Autumn surface.

The [tool availability audit](./EXECUTOR-TOOL-AVAILABILITY.md) lists restored reads and every remaining provider-tool exclusion.

The single operation list in `executor/toolkit-manifest.json` records the selected company operations and known missing coverage. Its default-deny policy excludes operations outside that list, including Executor administration. It does not divide permissions by workflow, requester, or subagent. The connection exposes `execute` and `skills`; it does not offer approval resume or artifacts. Personal Supermemory stays on its existing personal connection and sign-in path.

## Helpers and mappings

Authored helpers retain their public names, validation, fixed routes, pagination, workspace membership checks, field filtering, deadlines, and result formats. Their underlying API operations are included in the same toolkit and can be discovered directly. Helper use is instructed rather than enforced by a separate hidden catalog.

`executor/operation-bindings.json` maps each fixed helper operation to an exact installed tool path and its arguments. `EXECUTOR_OPERATION_BINDINGS` supplies that mapping at runtime. Source argument fields come from validated request descriptors (`body`, `query`, `path`, `headers`) or query arguments (`args`); optional `number`, `boolean`, and `single` coercions preserve the provider schema. Unsupported routes, malformed mappings, and invalid inputs fail before transport. The API definitions under `executor/specs/` describe the existing custom connections.

All provider helpers authenticate through `EXECUTOR_MCP_CONNECTOR`, an app-scoped Vercel Connect API-key connector. Tokens stay out of tool arguments and results. The transport uses a fresh MCP session per invocation, rejects redirects, bounds responses to 8 MiB, and composes its 50-second deadline with caller cancellation. Helper-specific bounds remain in place. There is no direct-provider fallback.

## Configuration and verification

- `EXECUTOR_BASE_URL` defaults to `https://executor.acquisity.ai` and must be an HTTPS origin. The toolkit slug is `foreman`.
- The existing Executor account holds the company connections. The toolkit remains account-owned because this Executor version excludes personal connections from workspace-owned toolkits. Consolidation does not move credentials or change their ownership.
- `LINEAR_CONNECTOR` remains for inbound Agent Sessions and vision attachment downloads. Slack delivery, GitHub, Blob, investigation memory, models, and sandbox infrastructure remain separate.
- `pnpm executor:contract` reports the endpoint, selected operations, and required helper mappings. `pnpm executor:readiness` checks coverage. Add `--live` with `EXECUTOR_SETUP_PROFILE` to compare the live toolkit's mounts and policies with the manifest; the command never resolves provider credentials or invokes tools.
- Run `pnpm validate`, inspect compiled root/critic connections, and exercise platform reads, helper parity, expected writes on synthetic records, and critic read-only behavior on preview. Full-pipeline evaluations require a scratch repository.
- Logs record only outer tool/connection names, outcome, and session/turn identifiers. Use Executor invocation records for provider diagnosis; never log tool arguments, results, credentials, or provider error bodies.

Preview evidence and remaining release gates are in `EXECUTOR-PREVIEW.md`. Production connector attachment and deployment still require the release procedure. To roll back across toolkit consolidation, restore the previous revision's toolkit configuration before selecting a deployment that references the retired URLs.
