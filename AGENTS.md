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
pnpm test
pnpm validate
pnpm db:migrate
npx eve info
```

Verify with `pnpm validate`, then exercise both direct and factory paths in `pnpm dev`. Evals cost real tokens. Run `pipeline/full-pipeline` only with `PIPELINE_SCRATCH_REPO` set to a scratch repository.

## Eve conventions

- Read the relevant version-matched guide under `node_modules/eve/docs/` before using an API.
- Identity comes from filesystem paths, never a `name` field.
- Authored capabilities live only under `agent/`; evals live beside it.
- Declared subagents inherit no prompt, tools, connections, skills, or sandbox unless authored. Repository stations explicitly share the prepared parent sandbox through `defineSandbox(({ parent }) => parent.sandbox)`.
- Task-mode children cannot park. Keep approval-gated capabilities on the root; child git writes must remain safe by construction.
- Every callback handed to a dynamic tool needs a durable descriptor, and eve stamps one only on a callback authored inline inside a `defineTool({ ... })` call. The GitHub surface is a single dynamic tool returning all 31 entries, so one bare callback drops every `github__` tool from the session with nothing logged to the model. The extension's `overrides` accept only the stamped callbacks exported from `agent/lib/github/durable-callbacks.ts`, which is where the inline `defineTool` carriers live; the approval policies themselves stay in `agent/lib/github/approval.ts`. Never pass a callback to `overrides` from anywhere else.
- `agent/lib/models.ts` owns global model defaults and overrides. Public tools are `read_agent_models` and `set_agent_models`.
- `agent/lib/trust.ts` is the single trust authority. Shared repository knowledge and model writes use policies from `agent/lib/github/approval.ts`.
- GitHub extension calls pass `owner` and `repo` explicitly. Never restore a fixed extension context.
- Repository selection and validation live in `agent/lib/repository.ts`. GitHub channel hooks stamp signed webhook authority before the model runs. Slack and Linear stamp a session repository only from a full GitHub URL: a bare `owner/repo` token in free text cannot be told apart from a file path like `channels/github.ts`, and stamping one used to bind the session to a repository that does not exist and block every push. The model still reads the slug out of the request and passes it to `prepare_repository`. Only a signed webhook binds a push to one repository; an explicit authority is a default the request can override.
- The root `prepare_repository` tool reuses GitHub's channel checkout or clones at runtime, then writes `/workspace/.foreman/repository.json`. Stations read the marker rather than assuming a path.
- Handoff artifacts are ids, not inlined long documents. Artifact ids remain anchored, size-bounded, and write-once.
- Pipeline stabilization is webhook-driven only. There is no reconciliation schedule, and no polling loop may be reintroduced.
- Author every inbound Slack surface in `agent/channels/slack.ts`. eve falls back to its built-in handler for any surface left unauthored, and that default stamps no trust, no repository, and no intake-only marker, so a caller arrives untrusted and delivery parks on an approval card. Slack cannot answer an approval card: Vercel Connect forwards Events API events only, never interactive payloads, and eve matches a typed answer against the option id exactly, which the channel's `<slack_message>` envelope defeats.
- Slack channel IDs listed in `SLACK_INTAKE_ONLY_CHANNELS` are intake-only: conversation and investigation run as normal, but the session is stamped intake-only and `intakeOnlyPolicy` denies both push tools and `createPullRequest`, so changes are filed to Linear instead of delivered from Slack. Commenting stays open, because answering in the thread is the point.
- Every `principalType: "user"` connection authorizes through `userConnect` in `agent/lib/user-connect.ts`, never `connect()` directly. When a user-scoped grant is missing or lapsed in an intake-only session, it turns the sign-in request into a terminal failure the model can work around, so no status line reaches the thread and the turn never parks on a consent flow nobody in that channel can complete. Developer channels keep the normal consent flow on purpose: the reader there holds the grant, and completing it resumes the turn. App-scoped connections need nothing here, because they never run consent.
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
- Every interpolated branch passes `validateBranch`, which rejects protected branches, refs, `HEAD`, traversal, and unsafe characters.
- Merge tools remain excluded. A feature branch and pull request are the delivery boundary in both execution paths.
- Factory label intake verifies the labeler's repository permission. Trusted comments use signed association data.
- Autonomous runs cannot write repository knowledge, global model settings, or write-capable non-GitHub connections.
- All Blob prefixes are registered in `agent/lib/blob.ts`. General Blob tools must consult the registry.
- Repository knowledge keys derive from the explicit or signed selected repository. Reads may fall back to the matching legacy document; trusted writes always use `repository-knowledge/`.
- Pipeline state is repository-and-scope bound. It stores current head, processed feedback, readiness signals, and blocker history. Ignore stale events, deduplicate stable ids, and escalate on the third unchanged blocker set.
- Per-user preferences derive keys from `ctx.session.auth.current`; never accept a principal from model input and never store a repository target as a preference.
- Supermemory is attended-session recall, never repository authority or autonomous shared memory.
- Investigation memory is Foreman's own Postgres, reached only through `FOREMAN_MEMORY_DATABASE_URL` and the tools in `agent/tools/*_investigation_*.ts`. It is not repository knowledge, not user preferences, not pipeline state, and not the read-only `neon__*` MCP connection, which stays unrelated to memory. PlanetScale remains the only production and customer-data database, and the only source of a current blast radius: a stored affected count is a dated figure from one past investigation, never the current one.
- Investigation-memory access is its own stamp in `agent/lib/trust.ts`, deliberately narrower than `trusted`. Linear Agent Sessions, every Slack surface the app is invited into, and the local dev TUI carry it. GitHub sessions, unattended factory runs, and schedules never do, and an unstamped session reads nothing. Writes additionally require an attended session and are denied, never parked.
- A case's product area comes from the ticket's Linear project through the mapping in `agent/lib/investigation-memory/scope.ts`, never from a symptom, a title, a repository, or an environment variable. An unmapped project records nothing and routes to Aaron Fraga as the triage skill already requires. There is no generic `shared` scope: one case has one primary feature, plus evidence-backed affected features and dependency keys.
- The shared case store holds sanitized patterns. Customer emails, organization and user ids, production rows, logs, attachments, and credentials are rejected at the tool boundary and stay in the ticket's `Triage investigation` document. Corrections supersede prior conclusions without deleting them.
- Retrieved cases are historical analogies, never current truth. They can raise a possible-wider-incident signal; they cannot declare an outage, mark a duplicate, pick a master, or set severity. A memory failure never holds a ticket or changes a verdict.
- Any regex built from data must escape literals and bound input length.

## Before committing

- `pnpm validate` passes with zero errors and warnings.
- No secrets, `node_modules`, `.eve`, `.vercel`, `.output`, or build artifacts are staged.
- A request to do the work and deliver it is the authorization to branch, commit, push, and open a PR. Carry it through and report the result instead of stopping to ask. A Linear ticket must exist before a PR is opened; create one when none exists.
- Marking a PR ready and merging still need the user's explicit word.
