<img width="100%" alt="Foreman" src=".github/banner.png" />

# Foreman

Foreman is Acquisity's general-purpose agent, built on [eve](https://eve.dev). It answers questions, investigates connected systems, operates services, and makes well-scoped repository changes directly. It uses eve's native delegation for independent subtasks and retains critic and vision for triage review and image analysis.

## Surfaces

Foreman runs on four channels, with GitHub and browser extensions, one shared company-service Executor connection, and a personal Supermemory connection:

- **GitHub** — trusted mentions (owners, members, collaborators) dispatch interactive sessions. Labels, PR opens, CI changes, reviews, and synchronizations do not launch work or automatic summaries.
- **Linear** — Agent Sessions trusted by workspace membership. Assigned issues use the same general agent.
- **Slack** — mentions and DMs trusted by channel membership. Channels listed as intake-only can investigate and answer but cannot ship code. An ask filed in the mismatched intake channel is handled in place: the reply notes which kind of ask it is and the matching triage procedure runs there, with the project and labels routed from the evidence rather than the channel. A screenshot or file attached to a mention is staged by eve under `/workspace/attachments` in the sandbox, and the Slack channel adds one context line naming the files and that directory, so the text-only chat model can hand the path to the vision subagent on the same turn.
- **eve** — the HTTP channel for the local dev TUI and Vercel OIDC.

The GitHub extension adds an API surface (reads, triage, PR authoring; no merge) and the browser extension adds agent-browser, both running inside the sandbox.

Foreman reaches company services through Executor, using shared company accounts for authorized investigations. Existing bounded helpers still perform customer lookup, billing, Instantly investigation, run searches, Linear routing, and help-center searches; their provider calls go through Executor. Root, native delegates, critic, and scheduled work use one shared Foreman toolkit. Personal Supermemory remains a separate user-scoped connection. Company-service credentials stay in Executor; Vercel Connect brokers Foreman's Executor credential and the retained channel and personal connections. See [.github/EXECUTOR-CONTRACT.md](.github/EXECUTOR-CONTRACT.md) for the shared toolkit, exact helper bindings, and the preview-first cutover. This revision requires that setup before provider traffic is enabled.

## Skills

Skills under `agent/skills/` are load-on-demand procedures the model pulls in when a task calls for them. They include triage and billing investigation, GitHub and code-quality review, GitHub-Linear bridging, SLA investigation, clarification, and writing and Slack wording guardrails. Loading a skill adds instructions only; it never adds tools.

## Execution

Foreman handles conversation, investigation, service operations, and repository changes with one general prompt. For an authorized change it resolves the repository, prepares a workspace, creates a validated feature branch, makes the change, runs proportionate checks, pushes, and opens a pull request. Foreman never merges.

The root can use eve's native `agent` tool for independent subtasks. On eve 0.44 each call creates a fresh copy with the root's instructions, tools, connections, and sandbox; the child starts with fresh history and state and cannot delegate recursively. Give children self-contained instructions and avoid concurrent edits to the same files. Critic remains the independent read-only triage reviewer. Vision reads staged screenshots in the shared sandbox. There is no authored station pipeline, run-state coordinator, or automatic GitHub stabilization.

## Trust and safety

`agent/lib/trust.ts` is the single trust authority. Scheduled runs are denied shared-config writes (repository knowledge and model overrides), plus personal Supermemory writes because nobody is watching to answer an approval card. For repository knowledge and model settings, trusted attended callers write directly; other attended callers park on a card. Company services share the Executor catalog across workflows. Merge tools are absent; the delivery boundary is a feature branch and pull request for repository work. Git commands use the validated literal `https://github.com/<owner>/<repo>.git` URL, never mutable remote configuration, and credentials are injected at the sandbox firewall.

## Repository targeting

There is no deployment-wide repository setting.

- GitHub sessions use the repository from the signed webhook. Issue or comment text cannot redirect that signed binding.
- Linear, Slack, and eve requests involving repository work must include exactly one `owner/repo` or GitHub URL. Ordinary conversation does not require a repository target.
- Missing or ambiguous targets require clarification.
- Workspaces clone at runtime when a GitHub channel checkout is unavailable. Native delegates and vision share the prepared parent workspace; critic keeps its own sandbox for independent review.

## Durable state

Durable documents live in one Vercel Blob store. Reserved prefixes are registered in `agent/lib/blob.ts`. Investigation memory is separate, in its own Postgres database.

- `repository-knowledge/<repository-hash>.md` stores verified repository conventions and recurring build or review facts. Reads fall back to the matching legacy `factory-brain/` document until the next trusted write migrates it.
- `model-overrides/foreman.json` stores global agent model overrides.
- `user-preferences/` is principal-scoped. Supermemory supports broader attended-session recall, but neither is repository authority.
- `sla-report/` stores the daily SLA report dispatch marker.

Settled investigations, including ticketless Intercom and Slack ones and conclusions a colleague corrected in a thread, are indexed in a private Foreman-owned Postgres database, reached through `FOREMAN_MEMORY_DATABASE_URL` and never through the read-only Neon MCP connection. The schema lives in `migrations/` and applies with `pnpm db:migrate`, a manual release step and never part of agent startup. Run a new migration against production before relying on the code that needs it: until `0002` runs, a ticketless write fails on the `NOT NULL` project column and the tool reports `recorded: false` without touching the verdict. It holds sanitized case patterns, not customer data: PlanetScale remains the only production database and the only source of current blast radius. Access is fail-closed and stamped per channel, so GitHub sessions and unattended runs cannot read or write it.

## Operations logging

`agent/hooks/ops.ts` writes one bounded JSON line per lifecycle event through `logOpsEvent` in `agent/lib/ops-log.ts`, so `vercel logs` can be counted. The eleven events are `session.started`, `session.completed`, `session.failed`, `turn.started`, `turn.completed`, `turn.cancelled`, `turn.failed`, `step.failed`, `authorization.required`, `input.requested`, and `action.result`. `action.result` covers every tool call, not only the failures, so a scan can tabulate reach and failure per tool and per connection: it names the tool, the connection derived from the `<connection>__<tool>` shape or none for an authored root tool, `ok` or `error`, the session id, and the turn id. It logs no error code, because eve derives that code from the tool's own output. It carries no duration, because neither event's data carries a timing field and an elapsed time would mean diffing the two events' `meta.at` envelope stamps out of state the hook is not allowed to keep. No line ever contains a tool input, a tool output, a message body, or customer data.

## Schedules

- `sla-report` runs daily at 13:00 UTC, dispatching a per-feature SLA bug investigation into each feature's Slack channel plus a health heartbeat.
- `ai-sdr-report` runs Mondays at 13:00 UTC, dispatching a weekly AI SDR performance report (volume, conversion rates, campaign type, and lifecycle) into the AI SDR channel.

## Configuration

| Executor setting | Purpose |
| --- | --- |
| `EXECUTOR_MCP_CONNECTOR` | App-scoped Vercel Connect UID for the Executor bearer credential |
| `EXECUTOR_BASE_URL` | HTTPS origin; defaults to `https://executor.acquisity.ai` |
| `EXECUTOR_OPERATION_BINDINGS` | Verified operation paths only; argument schemas live in source; no provider tokens |


| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_CONNECTOR` | `github/foreman-agent` | GitHub channel, API, and brokered git credentials |
| `LINEAR_CONNECTOR` | `linear/foreman-agent` | Linear Agent Sessions and vision attachment reads |
| `SLACK_CONNECTOR` | `slack/acquisity-foreman` | Slack inbound delivery and replies |
| `FOREMAN_BOT_NAME` | GitHub App slug | Mention and commit identity override |
| `FOREMAN_REVIEW_BOT_LOGINS` | empty | Comma-separated lowercase bot logins for an explicitly requested AI review-bot loop; supply the chosen logins in the request because the sandbox cannot read this setting. It does not start automatic reviews. |
| `SLACK_INTAKE_ONLY_CHANNELS` | empty | Comma-separated Slack channel IDs that can talk and investigate but cannot deliver code |
| `FOREMAN_MEMORY_DATABASE_URL` | unset | Pooled Postgres connection for investigation memory; unset disables it without affecting triage |
| `VERCEL_SANDBOX_BASE_SNAPSHOT_ID` | unset | Warm snapshot id for the session template; unset falls back to a cold clone |

See [.env.example](.env.example) for the Executor and retained channel/personal connection settings. No repository or setup command is configured through the environment.

### Session limits

The root agent sets `limits: { maxInputTokensPerSession: false }` in [agent/agent.ts](agent/agent.ts). eve defaults to a 40M-token input budget per session, and cached prompt re-reads count as provider-reported input on every model call, so a long Slack thread can cross it and park the session on eve's Approve/Stop budget card, which Slack cannot answer. Output stays on eve's existing uncapped default.

### Instantly admin workspace

Foreman reads Instantly through the Acquisity admin workspace `IBG` (`24f5c554-bf6c-4f51-a909-d25d9617cff9`). The runtime lists Workspace Group pages up to a 100-page safety cap, keeps only accepted memberships, and applies `x-as-workspace` only after resolving the selected subworkspace against that complete bounded result. Reaching the cap fails closed instead of returning a partial list. Every resource page returns the selected workspace name and ID.

Keep the existing IBG admin-workspace connection in Executor with read-only workspace-group, account, campaign, and email scopes. Include those operations in the shared Foreman toolkit. Foreman still resolves complete workspace membership before selecting `x-as-workspace` and filters the returned account, campaign, and email fields. The underlying operations remain discoverable in that same toolkit; skills prefer the bounded helpers.

To rotate the credential, create a replacement key with the same read-only scopes, replace the credential in the existing connector, verify that `list_instantly_subworkspaces` and one bounded resource read succeed, then revoke the old key. The key must not enter source control, app environment variables, browser responses, logs, tickets, or tool results.

New customer workspaces need no Foreman configuration. Invite the workspace to IBG's Workspace Group and wait for its owner to accept. `list_instantly_subworkspaces` excludes pending and rejected invitations and discovers the accepted workspace on its next call. Resource reads expose one bounded page at a time and return `nextStartingAfter`; callers pass it back as `startingAfter`. The tools retry short transient/rate-limit responses with bounded backoff and return a safe error for long `Retry-After` windows, inaccessible workspaces, or revoked credentials. Every resource result uses an explicit investigative-field allowlist. Email reads always request preview-only data and remove message bodies, attachments, and all provider address representations from the tool result.

## Development

```bash
pnpm install
pnpm dev
pnpm validate
pnpm eval --tag fast
pnpm report:capabilities
```

`pnpm validate` checks generated Linear-spec drift, then runs Ultracite formatting and lint, TypeScript, `eve info` discovery, and unit tests, in that order: the capability-budget test reads the compiled manifest, so discovery must run first. `pnpm report:capabilities` measures the tool, skill, subagent, and schema characters each session lane carries: it compiles the manifest first, counts the GitHub extension's tools only after eve's own dynamic-tool preparation admits them, reads eve's subagent delegation schema from eve, and fails instead of publishing a partial total or one for tools eve would drop. It reports and gates nothing. The `validate` GitHub Actions workflow runs the same `pnpm validate` on every pull request to `main`, with placeholder connector UIDs as plain workflow environment variables so `eve info` compiles the manifest and the manifest-dependent tests run for real; it references no secret. Evals use real model calls. `routing/native-delegation` dispatches two real read-only child tasks. `routing/direct-scratch-repository` is opt-in: set `FOREMAN_SCRATCH_REPO=owner/repo` and `FOREMAN_SCRATCH_TICKET` to an existing test ticket; it requires an untrusted Eve eval principal, approves one scoped push, and opens a real PR into `main`, so use a scratch repository with that base branch only. Follow [.github/UAT-BATTERY.md](.github/UAT-BATTERY.md) on each PR.

Deployment uses Vercel Connect for GitHub, Linear, and the app-scoped Executor credential; Vercel Blob for durable documents; Vercel Sandbox for workspaces; and the Vercel AI Gateway for models.

Production deploys from `main` through Vercel. Roll back by reverting the change on `main` and deploying that commit; never use `vercel rollback`. Aaron tests each PR before the next opens. Preview connector routing and Executor setup are in [.github/EXECUTOR-PREVIEW.md](.github/EXECUTOR-PREVIEW.md).
