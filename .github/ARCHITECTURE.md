# Foreman architecture

Foreman is a repository-neutral eve agent with a general execution path and an optional factory path.

## Routing

General mode handles conversation, investigation, connected-service work, and small repository changes directly. Slack and Linear sessions (including assigned issues) remain general by default. The `factory-pipeline` skill is advertised by task characteristics: explicit factory requests, complexity, uncertainty, risk, or requested review depth.

Factory mode activates deterministically only for a trusted GitHub issue label matching `FOREMAN_FACTORY_LABEL`. GitHub factory-label and stabilization turns use the autonomous principal and inline the pipeline instructions. Interactive sessions load the skill on demand.

## Repository binding

`agent/lib/repository.ts` validates repository slugs, extracts explicit targets, stamps signed channel context, derives literal remote URLs, and reads the prepared workspace marker.

- GitHub hooks stamp the signed webhook repository as `github-webhook`; it is authoritative.
- Slack and Linear stamp an explicit repository only when exactly one is present.
- `prepare_repository` refuses missing, ambiguous, conflicting, or mid-session replacement targets. It reuses `/workspace` after GitHub channel checkout or clones to `/workspace/repo` at runtime.
- GitHub extension calls supply `owner` and `repo` explicitly. The extension has no fixed context.
- Analyst, investigator, implementer, and reviewer share the root sandbox. The reviewer checkout tool verifies and hard-resets to the exact pushed SHA.

Every clone, fetch, and push targets `https://github.com/<validated-owner>/<validated-repo>.git` literally. Installation credentials are injected by `brokerPolicy` at the sandbox firewall and removed in `finally`. `validateBranch` rejects protected or non-plain branch names.

## Factory lifecycle

The ordered stations are classifier, investigator, analyst, implementer, and reviewer. The root investigates relevant production tools before planning and passes self-contained evidence to children. Task-mode children cannot park and receive only their authored tools and the shared sandbox.

After the reviewer approves the exact pushed head and an existing Linear ticket is confirmed, Foreman opens a normal pull request. Trusted GitHub labels authorize intake only. `pipeline-runs/` persists source Linear ids, repository, PR, head SHA, stage, processed feedback ids, readiness signals, blockers, and consecutive blocker count. Current-head CI failures, trusted collaborator comments, and PR synchronizations drive revisions on the existing branch. Webhooks are the only trigger; there is no reconciliation schedule. Feedback is deduplicated, stale heads are ignored, and the third unchanged blocker set escalates.

Readiness requires all of: internal approval for the current head, passing required checks, mergeability, no actionable trusted feedback, and no blockers. Readiness and escalation are reported to the PR and originating Linear context. Merge tools are absent.

## Channels and trust

- GitHub verifies Connect-forwarded webhooks. Mentions dispatch only for owners, members, and collaborators. Label intake additionally checks the labeler's repository permission. Signed repository context is stamped before any model step.
- Linear Agent Sessions are trusted by workspace membership. A `created` event with an issue adds only requester attribution; `prompted` continues the current mode.
- Slack mentions are trusted by channel membership and have no factory default.
- The Eve HTTP channel uses local dev or Vercel OIDC auth.

`agent/lib/trust.ts` is the sole caller-trust authority. Autonomous runs are denied writes to shared repository knowledge, global model configuration, and write-capable non-GitHub connections. Trusted attended callers write directly; other callers receive approval prompts.

Investigation-memory access is a separate, narrower stamp on the same authority. Linear Agent Sessions, every Slack surface the app is invited into, and the local dev TUI carry it; GitHub sessions, unattended factory runs, and schedules never do. It is fail-closed: an unstamped session reads nothing.

## Storage

All Blob namespaces are registered in `agent/lib/blob.ts`.

- `repository-knowledge/<repository-hash>.md`: verified shared facts. Reads fall back to legacy `factory-brain/<repository-hash>.md`; trusted writes always use the new namespace.
- `pipeline-runs/<repository-hash>/<scope>.json`: stabilization state.
- `model-overrides/foreman.json`: global model overrides used at session start.
- `user-preferences/<principal-hash>.md`: private principal preferences.
- `artifacts/<validated-id>.md`: write-once station handoffs.

Supermemory is available for broader attended-session recall, never as repository authority or autonomous shared memory, and never the backing store for investigation memory.

Investigation memory is a private Foreman-owned Postgres database, separate from Blob, from Acquisity production data, and from the read-only `neon__*` MCP connection. `FOREMAN_MEMORY_DATABASE_URL` is server-side only. `migrations/` holds the schema, applied explicitly with `pnpm db:migrate`, never at agent startup. Each completed triage investigation has one active revision, scoped by the tenant key plus one primary feature derived from the ticket's Linear project, with evidence-backed affected features and dependency keys alongside it. Corrections insert a new revision and supersede the old one in the same transaction; nothing is deleted, so a ticket accumulates rows and exactly one of them is active. Rows are meant to carry sanitized patterns only. The tool boundary enforces what a pattern can enforce, and only over free text: bounded lengths, and rejection of email addresses, organization and user ids, connection strings, and credential-shaped tokens. The evidence fields are deliberately looser, because the identifier rule cannot tell an organization id from a Sentry request id or an Inngest run id: evidence handles, error signatures, code paths, and symptoms accept opaque identifiers, while the prose that describes the customer's situation does not. The source ticket and document links are only bounded and shape-checked. They point at our own Linear and are written by an authorized triage session, so there is no adversary to harden them against. Nothing there recognizes an arbitrary production row or log line, so keeping those out is the triage procedure's job, and they belong in the ticket's `Triage investigation` document. `agent/lib/investigation-memory/` owns the taxonomy, the schemas, and the store.

## Verification

`pnpm validate` runs Ultracite, TypeScript, unit tests, and `eve info`. Unit tests cover repository parsing and webhook authority, protected branches and literal remotes, stale events, feedback deduplication, third-repeat escalation, readiness, and scoped run keys. Routing and safety evals cover the direct path, explicit factory selection, ordinary conversation, station order, knowledge and model approvals, and the human merge boundary. The full pipeline eval requires an explicit scratch repository.
