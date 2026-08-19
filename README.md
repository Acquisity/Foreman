<img width="100%" alt="Foreman" src=".github/banner.png" />

# Foreman

Foreman is Acquisity's general-purpose agent, built on [eve](https://eve.dev). It answers questions, investigates connected systems, operates services, and can make well-scoped repository changes directly. Its software factory is an optional mode for work that benefits from deeper investigation, planning, implementation, independent review, and pull request stabilization.

## Execution paths

General mode is the default for Slack and ordinary interactive sessions. Small code and documentation changes stay direct: Foreman resolves the repository, prepares a workspace, creates a `foreman/` feature branch, makes the change, runs proportionate checks, pushes, and opens a pull request when requested. It does not invoke factory stations merely because files change.

Factory mode runs these stations in order:

1. Classifier: triage and clarification.
2. Investigator: repository-grounded reproduction and root cause.
3. Analyst: plan, risks, acceptance criteria, and verification strategy.
4. Implementer: code, checks, commit, and feature-branch push.
5. Reviewer: independent review of the exact pushed commit.

An assigned Linear issue and a trusted GitHub `factory` label activate factory mode deterministically. Interactive users can request it explicitly, and Foreman may select it when complexity, uncertainty, risk, or requested review depth warrants the full line. Slack has no factory default.

After internal review, Foreman opens a normal pull request and stabilizes the same branch against current-head CI failures and actionable feedback from trusted collaborators or allowlisted review bots. A ten-minute reconciliation schedule recovers missed webhooks. It reports `ready to merge` only when internal review approves the current head, required checks pass, GitHub reports no conflict, and no actionable trusted feedback remains. Foreman never merges.

## Repository targeting

There is no deployment-wide repository setting.

- GitHub sessions use the repository from the signed webhook. Issue or comment text cannot redirect an unattended run.
- Linear, Slack, and eve requests involving repository work must include exactly one `owner/repo` or GitHub URL. Ordinary conversation does not require a repository target.
- Missing or ambiguous targets require clarification.
- Workspaces clone at runtime when a GitHub channel checkout is unavailable. Factory stations share the prepared parent workspace, and the reviewer fetches and resets to the exact pushed SHA.
- Git credentials are injected at the sandbox firewall. Clone, fetch, and push commands use the validated literal GitHub URL, never mutable remote configuration.

## Durable state

- `repository-knowledge/<repository-hash>.md` stores verified repository conventions and recurring build or review facts. Reads fall back to the matching legacy `factory-brain/` document until the next trusted write migrates it.
- `pipeline-runs/` stores repository-and-source or repository-and-PR state, including Linear context, head SHA, stage, processed feedback, and blocker history.
- `model-overrides/foreman.json` stores global agent model overrides.
- `user-preferences/` remains principal-scoped. Supermemory can support broader attended-session recall, but neither is repository authority.
- `artifacts/` stores size-bounded, validated handoff documents between stations.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_CONNECTOR` | connector fallback | GitHub channel, API, and brokered git credentials |
| `LINEAR_CONNECTOR` | connector fallback | Linear Agent Sessions and MCP |
| `FOREMAN_BOT_NAME` | GitHub App slug | Mention and commit identity override |
| `FOREMAN_BRANCH_PREFIX` | `foreman/` | Foreman-owned feature branches |
| `FOREMAN_FACTORY_LABEL` | `factory` | Trusted GitHub label activating unattended factory mode |
| `FOREMAN_REVIEW_BOT_LOGINS` | empty | Comma-separated lowercase review bot allowlist |

See [.env.example](.env.example) for all connection UIDs. No repository or setup command is configured through the environment.

## Development

```bash
pnpm install
pnpm dev
pnpm validate
pnpm eval --tag fast
```

`pnpm validate` runs formatting and lint checks, TypeScript, unit tests, and Eve discovery diagnostics. Evals use real model calls. The full pipeline eval is opt-in and requires `PIPELINE_SCRATCH_REPO=owner/repo`; it pushes a real branch, so use a scratch repository only.

Deployment uses Vercel Connect for GitHub and Linear, Vercel Blob for durable documents, Vercel Sandbox for workspaces, and Vercel AI Gateway for models.
