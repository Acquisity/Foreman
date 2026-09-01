# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

Foreman is Acquisity's general-purpose agent, built on eve. Slack and ordinary interactive work use a direct general path. The optional factory path normally runs classifier → investigator → analyst → implementer → reviewer, with researcher running in parallel with classifier when research is warranted, then stabilizes a normal pull request until it is ready to merge or escalated. A trusted GitHub `factory` label activates the factory deterministically; interactive sessions (Slack, Linear, eve) can request it or select it for complex, uncertain, risky, or review-heavy work. Foreman never merges.

Repositories are selected per signed session or explicit request. GitHub webhooks are authoritative. Linear, Slack, and eve requests involving repository work need exactly one `owner/repo` or GitHub URL; ordinary conversation does not. Never add an environment, memory, or preference fallback for repository identity.

The whole agent lives under `agent/`; evals live under `evals/`. See [ARCHITECTURE.md](./.github/ARCHITECTURE.md).

## Commands

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm check
pnpm fix
pnpm build
pnpm eval
pnpm report:capabilities
pnpm test
pnpm validate
pnpm db:migrate
npx eve info
```

Verify with `pnpm validate`, then exercise both direct and factory paths in `pnpm dev`. Evals cost real tokens. Run `pipeline/full-pipeline` only with `PIPELINE_SCRATCH_REPO` set to a scratch repository.

`pnpm report:capabilities` prints the capability catalog each session lane carries, measured from eve's compiled manifest by `agent/lib/capability-budget.ts`. Run `npx eve info` first so the manifest exists. The report measures only; it never decides what a lane may call.

## Eve conventions

- Read the relevant version-matched guide under `node_modules/eve/docs/` before using an API.
- Identity comes from filesystem paths, never a `name` field.
- Authored capabilities live only under `agent/`; evals live beside it.
- The root agent sets `limits: { maxInputTokensPerSession: false }` in `agent/agent.ts`. Cached prompt re-reads count as provider-reported input on every model call, so eve's default 40M per-session input budget can park a long Slack thread on an Approve/Stop budget card the channel cannot answer. Output stays on eve's existing uncapped default; keep it that way unless a billing decision says otherwise.
- Declared subagents inherit no prompt, tools, connections, skills, or sandbox unless authored. Repository stations explicitly share the prepared parent sandbox through `defineSandbox(({ parent }) => parent.sandbox)`.
- Task-mode children cannot park. Keep approval-gated capabilities on the root; child git writes must remain safe by construction.
- Every callback handed to a dynamic tool needs a durable descriptor, and eve stamps one only on a callback authored inline inside a `defineTool({ ... })` call. The GitHub surface is a single dynamic tool returning all 31 entries, so one bare callback drops every `github__` tool from the session with nothing logged to the model. The extension's `overrides` accept only the stamped callbacks exported from `agent/lib/github/durable-callbacks.ts`, which is where the inline `defineTool` carriers live; the approval policies themselves stay in `agent/lib/github/approval.ts`. Never pass a callback to `overrides` from anywhere else.
- Every Foreman-authored call that leaves the process has a deadline or a documented exemption, and each one is inventoried in [OUTSIDE-CALLS.md](./.github/OUTSIDE-CALLS.md) with the reason for its bound or exemption. Deadlines are per provider on purpose: there is no shared fetch wrapper, and one is not wanted. Sandbox commands do share `boundedRun` from `agent/lib/sandbox-deadline.ts`, which reports a deadline as exit code 124 so each caller's existing failure branch handles it while a cancelled turn still throws. A new outside call goes in that table.
- `agent/lib/models.ts` owns global model defaults and overrides. Public tools are `read_agent_models` and `set_agent_models`.
- `agent/lib/trust.ts` is the single trust authority. Shared repository knowledge and model writes use policies from `agent/lib/github/approval.ts`.
- GitHub extension calls pass `owner` and `repo` explicitly. Never restore a fixed extension context.
- Repository selection and validation live in `agent/lib/repository.ts`. GitHub channel hooks stamp signed webhook authority before the model runs. Slack and Linear stamp a session repository only from a full GitHub URL: a bare `owner/repo` token in free text cannot be told apart from a file path like `channels/github.ts`, and stamping one used to bind the session to a repository that does not exist and block every push. The model still reads the slug out of the request and passes it to `prepare_repository`. Only a signed webhook binds a push to one repository; an explicit authority is a default the request can override.
- The root `prepare_repository` tool reuses GitHub's channel checkout or clones at runtime, then writes `/workspace/.foreman/repository.json`. Stations read the marker rather than assuming a path. Preparing the repository the marker already names reuses it. An attended session may name a different validated repository and replace it: the old checkout is moved to a tool-owned path first, so a failed switch puts it back and keeps the marker it had. A rollback that itself fails clears the marker, and the session is left with no repository prepared. Before either reuse or a switch trusts the marker, an interrupted switch is settled by provenance: a published checkout the marker names keeps its place and the set-aside copy is debris, one it does not name is rolled back, and an origin that cannot be read fails closed instead of guessing. A signed GitHub checkout, an unattended run, and a checkout at `/workspace` are never replaced. A refreshed checkout reinstalls dependencies only when the repository's own lockfile moved between the old and new HEAD, or when its install state is unknown. Every refusal, from either tool, returns `success: false` with its reason and leaves exactly one bounded `logOpsEvent` warning, so a refused preparation or push is operator-visible instead of silent.
- Handoff artifacts are ids, not inlined long documents. Artifact ids remain anchored, size-bounded, and write-once.
- Pipeline stabilization is webhook-driven only. There is no reconciliation schedule, and no polling loop may be reintroduced.
- Author every inbound Slack surface in `agent/channels/slack.ts`. eve falls back to its built-in handler for any surface left unauthored, and that default stamps no trust, no repository, and no intake-only marker, so a caller arrives untrusted and delivery parks on an approval card. Slack cannot answer an approval card: Vercel Connect forwards Events API events only, never interactive payloads, and eve matches a typed answer against the option id exactly, which the channel's `<slack_message>` envelope defeats.
- Slack uses the `queue` turn policy: a later mention waits behind the running turn instead of cancelling it and losing the earlier request. Only a message that is just `stop` or `cancel` (matched by `agent/lib/slack-stop.ts`, with optional mentions, case, and terminal punctuation) cancels the active turn, intercepted in `agent/channels/slack.ts` dispatch before model delivery; the `turn.cancelled` handler posts the one short notice, and a `stop` with no active turn stays quiet. Longer requests such as `stop the deploy` are ordinary model input.
- A Slack turn still running at 5 and 15 minutes posts one short progress line per threshold and never a third. `agent/lib/slack-progress.ts` owns the pure decision and `agent/channels/slack.ts` owns the state: `turn.started` seeds it for every session except intake-only ones (those threads stay quiet), `reasoning.appended`, `actions.requested`, and `action.result` are the checkpoints, and the final `message.completed` branch, `turn.cancelled`, and `turn.failed` clear the state without checking, so a progress line never lands next to the final reply. The overridden events mirror eve's unexported defaults exactly. eve emits no event during a single uninterrupted tool execution and offers authored channel code no durable wakeup, so a line that comes due mid-action posts at the next lifecycle event.
- Slack channel IDs listed in `SLACK_INTAKE_ONLY_CHANNELS` are intake-only: conversation and investigation run as normal, but the session is stamped intake-only and `intakeOnlyPolicy` denies both push tools and `createPullRequest`, so changes are filed to Linear instead of delivered from Slack. Commenting stays open, because answering in the thread is the point.
- Every `principalType: "user"` connection authorizes through `userConnect` in `agent/lib/user-connect.ts`, never `connect()` directly. When a user-scoped grant is missing or lapsed in any Slack-issued session, including the SLA schedule's Slack principal, it turns the sign-in request into a terminal, non-retryable failure the model can work around, so no status line reaches the thread and the turn never parks on a consent flow Slack cannot answer. Linear Agent Sessions, local eve sessions, and app principals keep the normal consent flow. The one deliberate exception is the root `sign_in` tool: when a person explicitly asks to connect one service in an attended session, it probes the connection's wrapped authorization first and invokes consent through the unwrapped definition from `consentAuth` only for the known Slack-denial error, refusing unattended sessions and propagating unrelated errors unchanged. App-scoped connections need nothing here, because they never run consent.
- Intercom is deliberately app-scoped. Its private Acquisity workspace access token lives in a Vercel Connect API-key connector while requests still go to Intercom's MCP endpoint. It has no caller consent path. Its connection approval must deny untrusted GitHub sessions, including public pull request summaries, while allowing trusted internal sessions, attended investigation surfaces, and explicitly triggered autonomous factory runs. An authorization failure is deployment or operator configuration, not a reason to ask a Slack requester to sign in or to retry the same call. Never restore OAuth or article tools without revisiting this trust and scope design.
- Instantly is deliberately app-scoped and attended-investigation-only. Its IBG admin-workspace key lives in the Vercel Connect API-key connector named by `INSTANTLY_API_CONNECTOR`; the deployed app stores only that connector UID. Keep its provider scopes read-only and its authored tools on fixed GET routes. Resolve subworkspaces from a complete safety-bounded Workspace Group result before sending `x-as-workspace`, always return workspace name and ID provenance, and apply an explicit investigative-field allowlist to every account, campaign, and email item. Never expose full message bodies, attachment payloads, raw email-message address representations, credentials, or authentication headers in results or logs.

## Code style

- TypeScript strict, ESM with NodeNext; relative imports include `.js`.
- Validate tool inputs and outputs with Zod where practical.
- Prefer `const`, arrow functions, optional chaining, and nullish coalescing.
- Ultracite/Biome owns formatting. Use `pnpm fix`, then `pnpm check`.
- Markdown prose is not hard-wrapped.
- Agent-facing text uses plain language, no em dashes, no bold for emphasis, and no references to capabilities the reading agent does not have.

## Security

- Never ask for or commit credentials. Connector UIDs come from environment; tokens are brokered by Vercel Connect and Blob uses project OIDC.
- GitHub webhook repository context is authoritative. Message text cannot redirect it.
- Git commands use the validated literal `https://github.com/<owner>/<repo>.git` URL, never mutable remote configuration.
- Credentials are injected at the sandbox firewall and removed in `finally`; they never enter the sandbox process.
- Every interpolated branch passes `validateBranch`, which rejects protected branches, refs, `HEAD`, traversal, and unsafe characters. That is the whole branch gate: `push_branch` delivers any validated name, including a human branch such as `afragahaha/eng-13319`. `FOREMAN_BRANCH_PREFIX` marks the factory's own branches so the GitHub channel can recognize them for red-CI stabilization, which is ownership, not permission.
- Merge tools remain excluded. A feature branch and pull request are the delivery boundary in both execution paths.
- Factory label intake verifies the labeler's repository permission. Trusted comments use signed association data.
- Autonomous runs cannot write repository knowledge, global model settings, or write-capable non-GitHub connections.
- All Blob prefixes are registered in `agent/lib/blob.ts`. General Blob tools must consult the registry.
- Repository knowledge keys derive from the explicit or signed selected repository. Reads may fall back to the matching legacy document; trusted writes always use `repository-knowledge/`.
- Pipeline state is repository-and-scope bound. It stores current head, processed feedback, readiness signals, and blocker history. Ignore stale events, deduplicate stable ids, and escalate on the third unchanged blocker set.
- Per-user preferences derive keys from `ctx.session.auth.current`; never accept a principal from model input and never store a repository target as a preference.
- Supermemory is attended-session recall, never repository authority or autonomous shared memory.
- Investigation memory is Foreman's own Postgres, reached only through `FOREMAN_MEMORY_DATABASE_URL` and the tools in `agent/tools/*_investigation_*.ts`. It is not repository knowledge, not user preferences, not pipeline state, and not the read-only `neon__*` MCP connection, which stays unrelated to memory. Migrations under `migrations/` are additive and never run on deploy; `pnpm db:migrate` is run by hand against the production URL, before the merged code is relied on. Merging alone does not enable a write that needs a migration; the write fails closed with `recorded: false` until the migration runs. PlanetScale remains the only production and customer-data database, and the only source of a current blast radius: a stored affected count is a dated figure from one past investigation, never the current one.
- Investigation-memory access is its own stamp in `agent/lib/trust.ts`, deliberately narrower than `trusted`. Linear Agent Sessions, every Slack surface the app is invited into, and the local dev TUI carry it. GitHub sessions, unattended factory runs, and schedules never do, and an unstamped session reads nothing. Writes additionally require an attended session and are denied, never parked.
- Investigation-memory retrieval is project-independent. Every authorized attended triage surface searches the server-owned live product areas after stating the claim; incoming Linear project metadata, including a missing or unmapped project or an incoming `Support` project, never gates memory, establishes ownership, or triggers routing. After the investigation establishes the root cause and owning code path, final Linear handling chooses and saves the evidence-backed product project; `Support` is one of those when support closes the case without engineering, and it records like any other live area. Only that resulting project id scopes a Linear-sourced case write through `agent/lib/investigation-memory/scope.ts`. A ticketless Intercom or Slack investigation is keyed `intercom:<conversation id>` or `slack:<channel id>/<thread ts>`, carries no project id, and names its live product area directly; the enum is the bound, and a memory row's bucket never routes anything. Aaron Fraga is the fallback only when the completed investigation cannot determine ownership. Read-only validation is Aaron's explicit attended manual-test instruction, not a runtime authorization mode; it needs no session marker. There is no generic `shared` scope: one recorded case has one primary feature, plus evidence-backed affected features and dependency keys.
- The shared case store holds sanitized patterns. Customer emails, organization and user ids, production rows, logs, attachments, and credentials are rejected at the tool boundary and stay in the ticket's `Triage investigation` document. Corrections supersede prior conclusions without deleting them. A trusted human correcting Foreman in a thread is a memory event: the corrected conclusion is recorded with the overturned one in `ruledOut`, or supersedes the source's active case when one exists.
- Retrieved cases are historical analogies, never current truth. They can raise a possible-wider-incident signal; they cannot declare an outage, mark a duplicate, pick a master, or set severity. A memory failure never holds a ticket or changes a verdict.
- Any regex built from data must escape literals and bound input length.

## Before committing

- `pnpm validate` passes with zero errors and warnings.
- No secrets, `node_modules`, `.eve`, `.vercel`, `.output`, or build artifacts are staged.
- A request to do the work and deliver it is the authorization to branch, commit, push, and open a PR. Carry it through and report the result instead of stopping to ask. A Linear ticket must exist before a PR is opened; create one when none exists.
- Marking a PR ready and merging still need the user's explicit word.
