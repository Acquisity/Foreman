# Executor migration status

The company MCP and API integrations have been added to the hosted Executor service at `https://executor.acquisity.ai`, version 1.6.8. Earlier September 6 provider-setup blockers are historical and are not treated as current blockers in this implementation.

Foreman's code migration preserves shared triage access regardless of requester, current attended provider write tools, and the separate personal Supermemory connection. Its custom helpers remain in Foreman with their validation, filtering, pagination, provenance, and result contracts; Executor performs their provider calls.

Preview uses the single shared Foreman toolkit at `https://executor.acquisity.ai/mcp/toolkits/foreman?artifacts=false`, verified helper operation bindings, and the app-scoped Vercel Connect connector. Production attachment and configuration remain a separate release step. Validate the selected catalog and path-only helper bindings against this same toolkit before rollout. Missing configuration returns an unavailable source without falling back to direct provider calls.

See [EXECUTOR-AUDIT.md](./EXECUTOR-AUDIT.md) for the code audit and [EXECUTOR-CONTRACT.md](./EXECUTOR-CONTRACT.md) for provisioning and acceptance. Run `pnpm executor:contract` to print the shared endpoint and required helper operations, and `pnpm executor:readiness --live` with the selected operator profile to compare installed configuration. Preview setup and its remaining acceptance gaps are recorded in [EXECUTOR-PREVIEW.md](./EXECUTOR-PREVIEW.md); they do not establish production readiness.
