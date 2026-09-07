# Executor migration status

The company MCP and API integrations have been added to the hosted Executor service at `https://executor.acquisity.ai`, version 1.6.8. Earlier September 6 provider-setup blockers are historical and are not treated as current blockers in this implementation.

Foreman's code migration preserves shared triage access regardless of requester, current attended provider write tools, and the separate personal Supermemory connection. Its custom helpers remain in Foreman with their validation, filtering, pagination, provenance, and result contracts; Executor performs their provider calls.

The live service still needs the production Foreman toolkit profiles, verified helper operation bindings, and an app-scoped Vercel Connect credential before this code can serve provider traffic. The existing `Foreman Aaron Root` personal proof toolkit is not used as a production default. The default unrestricted `/mcp` endpoint is not used either. Missing configuration returns an unavailable source without falling back to direct provider calls.

See [EXECUTOR-AUDIT.md](./EXECUTOR-AUDIT.md) for the code audit and [EXECUTOR-CONTRACT.md](./EXECUTOR-CONTRACT.md) for the concrete provisioning and acceptance checklist. Run `pnpm executor:contract` to print all required profile URLs and helper operation identifiers. No key, connector, toolkit, provider policy, or production deployment was changed by this implementation.
