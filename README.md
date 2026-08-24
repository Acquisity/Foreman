<img width="100%" alt="Foreman" src=".github/banner.png" />

# Foreman

Foreman is Acquisity's general-purpose agent, built on [eve](https://eve.dev). It answers questions, investigates connected systems, operates services, and makes well-scoped repository changes directly. Its software factory is an optional mode for work that benefits from deeper investigation, planning, implementation, independent review, and pull request stabilization.

## Surfaces

Foreman runs on four channels, with a couple of extensions and a set of mostly read-only service connections:

- **GitHub** — trusted mentions (owners, members, collaborators) dispatch interactive sessions; a trusted `factory` label hands an issue to the pipeline unattended; red CI on a Foreman pull request triggers a fix loop.
- **Linear** — Agent Sessions trusted by workspace membership. Assigned issues stay general by default; the factory loads on demand.
- **Slack** — mentions and DMs trusted by channel membership. Channels listed as intake-only can investigate and answer but cannot ship code.
- **eve** — the HTTP channel for the local dev TUI and Vercel OIDC.

The GitHub extension adds an API surface (reads, triage, PR authoring; no merge) and the browser extension adds agent-browser, both running inside the sandbox.

Foreman also connects to mostly read-only services through MCP: Stripe, Sentry, Axiom, PostHog, PlanetScale (read-only, with a size-capped authored read-query tool), Neon, Resend, Intercom, Jam, Lucent, Modem, Exa, OpenRouter, Supermemory, Vercel, Inngest, and Linear. Connection UIDs are in [.env.example](.env.example); tokens are brokered by Vercel Connect and never reach the model. Intercom is app-scoped: its private Acquisity workspace token lives in an API-key connector, and Slack callers are never asked to authorize it.

## Skills

Skills under `agent/skills/` are load-on-demand procedures the model pulls in when a task calls for them. They include the factory pipeline, triage and billing investigation, GitHub and code-quality review, GitHub-Linear bridging, SLA investigation, clarification, and writing and Slack wording guardrails. Loading a skill adds instructions only; it never adds tools.

## Execution paths

General mode is the default for Slack, Linear, and ordinary interactive sessions. Small code and documentation changes stay direct: Foreman resolves the repository, prepares a workspace, creates a `foreman/` feature branch, makes the change, runs proportionate checks, pushes, and opens a pull request when requested. It does not invoke factory stations merely because files change.

Factory mode runs these stations in order:

1. Classifier: triage and clarification.
2. Investigator: repository-grounded reproduction and root cause.
3. Analyst: plan, risks, acceptance criteria, and verification strategy.
4. Implementer: code, checks, commit, and feature-branch push.
5. Reviewer: independent review of the exact pushed commit.

A researcher station runs in parallel with the classifier when a work item turns on an outside fact.

A trusted GitHub `factory` label activates factory mode deterministically. Interactive users can request it explicitly, and Foreman may select it when complexity, uncertainty, risk, or requested review depth warrants the full line. Linear and Slack have no factory default.

After internal review, Foreman opens a normal pull request and stabilizes the same branch against current-head CI failures and actionable feedback from trusted collaborators or allowlisted review bots. It reports `ready to merge` only when internal review approves the current head, required checks pass, GitHub reports no conflict, and no actionable trusted feedback remains. Foreman never merges.

## Trust and safety

`agent/lib/trust.ts` is the single trust authority. Unattended runs (GitHub factory-label intake, CI fix, and schedules) are denied shared-config writes (repository knowledge, model overrides, connection writes) because nobody is watching to answer an approval card. Trusted attended callers write directly; other callers park on a card. Merge tools are absent; the delivery boundary is a feature branch and pull request in both paths. Git commands use the validated literal `https://github.com/<owner>/<repo>.git` URL, never mutable remote configuration, and credentials are injected at the sandbox firewall.

## Repository targeting

There is no deployment-wide repository setting.

- GitHub sessions use the repository from the signed webhook. Issue or comment text cannot redirect an unattended run.
- Linear, Slack, and eve requests involving repository work must include exactly one `owner/repo` or GitHub URL. Ordinary conversation does not require a repository target.
- Missing or ambiguous targets require clarification.
- Workspaces clone at runtime when a GitHub channel checkout is unavailable. Factory stations share the prepared parent workspace, and the reviewer fetches and resets to the exact pushed SHA.

## Durable state

Durable documents live in one Vercel Blob store. Reserved prefixes are registered in `agent/lib/blob.ts`. Investigation memory is separate, in its own Postgres database.

- `repository-knowledge/<repository-hash>.md` stores verified repository conventions and recurring build or review facts. Reads fall back to the matching legacy `factory-brain/` document until the next trusted write migrates it.
- `pipeline-runs/` stores repository-and-source or repository-and-PR state, including Linear context, head SHA, stage, processed feedback, and blocker history.
- `model-overrides/foreman.json` stores global agent model overrides.
- `user-preferences/` is principal-scoped. Supermemory supports broader attended-session recall, but neither is repository authority.
- `artifacts/` stores size-bounded, write-once handoff documents between stations.
- `sla-report/` stores the daily SLA report dispatch marker.

Completed triage investigations are indexed in a private Foreman-owned Postgres database, reached through `FOREMAN_MEMORY_DATABASE_URL` and never through the read-only Neon MCP connection. The schema lives in `migrations/` and applies with `pnpm db:migrate`. It holds sanitized case patterns, not customer data: PlanetScale remains the only production database and the only source of current blast radius. Access is fail-closed and stamped per channel, so GitHub sessions and unattended runs cannot read or write it.

## Schedules

- `sla-report` runs daily at 13:00 UTC, dispatching a per-feature SLA bug investigation into each feature's Slack channel plus a health heartbeat.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_CONNECTOR` | `github/foreman-agent` | GitHub channel, API, and brokered git credentials |
| `LINEAR_CONNECTOR` | `linear/foreman-agent` | Linear Agent Sessions and MCP |
| `FOREMAN_BOT_NAME` | GitHub App slug | Mention and commit identity override |
| `FOREMAN_BRANCH_PREFIX` | `foreman/` | Foreman-owned feature branches |
| `FOREMAN_FACTORY_LABEL` | `factory` | Trusted GitHub label activating unattended factory mode |
| `FOREMAN_REVIEW_BOT_LOGINS` | empty | Comma-separated lowercase review bot allowlist |
| `SLACK_INTAKE_ONLY_CHANNELS` | empty | Comma-separated Slack channel IDs that can talk and investigate but cannot deliver code |
| `FOREMAN_MEMORY_DATABASE_URL` | unset | Pooled Postgres connection for investigation memory; unset disables it without affecting triage |
| `VERCEL_SANDBOX_BASE_SNAPSHOT_ID` | unset | Warm snapshot id for the session template; unset falls back to a cold clone |

See [.env.example](.env.example) for all MCP connection UIDs. No repository or setup command is configured through the environment.

## Development

```bash
pnpm install
pnpm dev
pnpm validate
pnpm eval --tag fast
```

`pnpm validate` runs Ultracite formatting and lint, TypeScript, unit tests, and `eve info` discovery. Evals use real model calls. The full pipeline eval is opt-in and requires `PIPELINE_SCRATCH_REPO=owner/repo`; it pushes a real branch, so use a scratch repository only.

Deployment uses Vercel Connect for GitHub and Linear, Vercel Blob for durable documents, Vercel Sandbox for workspaces, and the Vercel AI Gateway for models.
