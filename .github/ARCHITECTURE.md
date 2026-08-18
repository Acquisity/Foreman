# ARCHITECTURE.md

A map of how this agent is put together, for humans and AI agents working in the repo. Keep it current as the codebase evolves.

## Project identification

- **Name:** Foreman (Acquisity's general-purpose agent)
- **Maintainer:** Vercel Labs
- **License:** MIT
- **Last updated:** 2026-08-18

## Overview

Foreman is Acquisity's general-purpose agent built on the [eve](https://eve.dev) agent framework. Skills define its specialist modes, and the software factory is one of them: the `factory-pipeline` skill is the full station procedure, loaded on demand when a work item asks Foreman to fix, build, or change something in `FACTORY_REPO`. With no skill loaded, Foreman still handles whatever is delegated from the prompt alone: questions, summaries, triage, and routing. The system prompt resolves per caller through dynamic instructions: unattended factory runs (an issue labeled `factory`, red CI on a factory PR) run under the autonomous principal and get the full factory prompt inline, while every interactive session gets the general profile that reaches the pipeline through the dynamic `factory-pipeline` skill. The factory moves each work item through four stations, each a declared subagent with its own instructions, sandbox, and tool surface: **classifier** (triage), **analyst** (plan with acceptance criteria, grounded in a repo checkout), **implementer** (executes the plan in its own checkout, runs the repo's checks, pushes a feature branch), and **reviewer** (independent verdict on the pushed branch, different model vendor, up to 2 revision cycles). The finished product is a draft pull request on `FACTORY_REPO`. People stay in the loop where judgment lives: merging isn't in the tool surface at all (a person merges in the GitHub UI). GitHub tools run without approval cards for every caller. The remaining approval policies gate non-GitHub surfaces: the factory brain, model swaps, and connection writes. The agent runs on Vercel, the same way locally (`eve dev`) and in production (`eve deploy`).

eve discovers every capability from the filesystem under `agent/`. There is no central registry or wiring file: a tool's name is its filename, a subagent's name is its directory, an extension's namespace is its filename.

## Project structure

```text
agent/
  agent.ts                  # model resolution (no per-session output cap)
  instructions/
    prompt.ts               # defineDynamic on turn.started: the system prompt, resolved per caller (autonomous -> FACTORY_PROMPT, interactive -> GENERAL_PROMPT)
  channels/
    github.ts               # eve GitHub channel via Vercel Connect; botName resolved from the connector's app slug; four hooks: onComment (mention, association-gated, stamps trusted), onIssue ('factory' label -> unattended pipeline under the autonomous principal), onCheckSuite (red CI on factory/* PRs -> unattended fix loop, capped at 2 attempts), onPullRequest (summary comment on opened PRs, bots skipped)
    linear.ts               # eve Linear channel via Connect; Agent Sessions; stamps trusted (workspace membership is the gate), injects requester name and the factory intake task on issue delegation
    eve.ts                  # inbound route auth; dev-only localDevUser shim (user principal)
  connections/
    linear.ts               # Linear MCP server (mcp.linear.app); app-scoped auth via linearAuth; writes denied on unattended runs
  extensions/
    github.ts               # @github-tools/eve-extension mount: explicit include allowlist (no merge tools), FACTORY_REPO context, run without approval cards; tools appear as github__<name>
  sandbox.ts                # root sandbox (Vercel Sandbox); the GitHub channel checks the triggering thread's ref out here
  subagents/
    classifier/             # agent.ts (outputSchema) + instructions.md; text-only triage
    analyst/                # agent.ts (outputSchema) + instructions.md + sandbox.ts (repo clone) + tools/{save,read}_artifact.ts; plans, never writes
    implementer/            # agent.ts (outputSchema) + instructions.md + sandbox.ts + tools/checkout_branch.ts + tools/push_branch.ts + tools/read_artifact.ts
    reviewer/               # agent.ts (different vendor, outputSchema) + instructions.md + sandbox.ts + tools/checkout_branch.ts + tools/read_artifact.ts
    researcher/             # agent.ts + instructions.md + tools/save_artifact.ts; fresh-context web researcher
  tools/
    agent.ts                # disableTool(): the built-in agent tool would let the root bypass its stations
    get_user_preferences.ts   # Blob: load this user's saved preferences
    save_user_preferences.ts  # Blob: save standing preferences (principal-scoped)
    clear_user_preferences.ts # Blob: clear this user's preferences (approval-gated)
    read_factory_brain.ts     # Blob: load the shared factory brain (open to every run)
    update_factory_brain.ts   # Blob: write the shared factory brain (factoryBrainPolicy: trusted-write)
    read_artifact.ts          # Blob: read a handoff artifact by id (read-only, open to every run)
  lib/
    constants.ts            # requireEnv + FACTORY_REPO/factoryRepo/FACTORY_LABEL + linearAuth
    prompts.ts              # IDENTITY/WRITING/PIPELINE/MODEL_SWAPS/REPLIES_LAND/NEW_PRS/NOTES/GENERAL_MODE constants + FACTORY_PROMPT/GENERAL_PROMPT composition + isSlackSession
    trust.ts                # the single trust authority: AUTONOMOUS_PRINCIPAL, isAutonomous, isTrusted, isScheduleAppAuth, stampTrusted
    blob.ts                 # the shared Blob layer: reserved-namespace registry (all prefixes + guards) and read/write/delete document helpers
    user-preferences.ts     # principal-scoped Blob key derivation
    factory-brain.ts        # FACTORY_REPO-scoped Blob key derivation + size bound
    artifacts/              # handoff artifacts: config.ts (id pattern, kinds) + tools.ts (save/read tool factories)
    github/
      credentials.ts        # GITHUB_CONNECTOR + the shared Connect credentials handle
      approval.ts           # factoryBrainPolicy / modelSwapPolicy / denyAutonomousWrites
      git-remote.ts         # validateBranch, brokerPolicy (firewall credential), mintInstallationToken, REMOTE_URL, REPO_DIR
      repo-sandbox.ts       # factoryBootstrap / factoryOnSession / factoryRevalidationKey shared by the three station sandboxes
  skills/                   # load-on-demand procedures, routed by description frontmatter
    factory-pipeline.ts     # dynamic skill: the full station procedure (PIPELINE), advertised to interactive sessions only (autonomous sessions inline PIPELINE)
    writing-quality/        # AI-tells, plain English, prose specs
    triaging-issues/        # grounding a GitHub work item: dedupe, repo-native labels, ask-or-proceed, repro requests
    github-linear-bridging/ # bridged Linear issues: dedupe check, backlinks, team choice, two-way links
    billing-triage/         # billing support triage: verify, classify, and route billing tickets
    clarify-with-requester/ # ask-vs-investigate gate and the shared ask flow
    slack-wording/          # Slack reply wording conventions
    triage-investigate/     # investigation procedure for triage tickets
    triage-policy/          # triage routing policy
evals/                      # eve eval runner suite: smoke, routing/, safety/, pipeline/ (opt-in real run), helpers.ts, evals.config.ts
```

## Core components

| Component | Lives in | eve primitive | Responsibility |
| --- | --- | --- | --- |
| Root agent | `agent/agent.ts` + `instructions/prompt.ts` | Agent | General-purpose agent: answers questions, summarizes, triages, and routes; when a work item asks for a fix or build, loads the factory-pipeline skill and runs the stations in order, verifies handoffs, runs the review loop (max 2 cycles), opens the draft PR, reports back; never writes code itself |
| Prompt resolver | `agent/instructions/prompt.ts` | Dynamic instructions | Resolves the system prompt per caller at `turn.started`: autonomous (unattended factory) -> `FACTORY_PROMPT` inline, interactive -> `GENERAL_PROMPT` (pipeline via the skill) |
| Skill resolver | `agent/skills/factory-pipeline.ts` | Dynamic skill | Advertises the `factory-pipeline` skill (the `PIPELINE` constant) to interactive sessions on `turn.started`; autonomous sessions inline `PIPELINE` and get no duplicate skill |
| GitHub surface | `agent/channels/github.ts` | Channel | Intake and delivery: association-gated @Foreman mentions (stamped trusted), `factory`-label intake (rewritten to the autonomous principal, unattended framing injected), PR summary comments on opened PRs; replies render in-thread |
| Linear surface | `agent/channels/linear.ts` | Channel | Linear Agent Sessions: users delegate issues to the factory; every session is stamped trusted (workspace membership); delegating an issue injects the factory intake task (channel dispatch context) so the delegated issue runs the full pipeline; elicitations render natively |
| Route auth | `agent/channels/eve.ts` | Channel | Inbound auth for the eve route; the `localDevUser` shim upgrades the dev principal to a user so user-scoped features work in the dev TUI |
| GitHub tools | `agent/extensions/github.ts` | Extension | The orchestrator's GitHub surface as `github__*` tools: reads, triage writes, PR authoring; an explicit allowlist (no preset, no merge tools) with no approval gates |
| Trust authority | `agent/lib/trust.ts` | Library | The only place caller trust is defined: trusted (stamped at dispatch), autonomous (label intake), schedule app auth; new capabilities gate on these predicates rather than inventing their own checks |
| classifier | `agent/subagents/classifier/` | Subagent | Task-mode triage on a fast model; returns type/priority/complexity/area/actionable/needs_clarification |
| analyst | `agent/subagents/analyst/` | Subagent | Task-mode planning against its own repo checkout; returns problem statement, approach, plan, risks, acceptance criteria, test strategy |
| implementer | `agent/subagents/implementer/` | Subagent | Task-mode implementation in its own checkout: branch, code, run the repo's checks, commit, `push_branch`; returns branch + change summary + verification |
| reviewer | `agent/subagents/reviewer/` | Subagent | Task-mode independent review on a different vendor: `checkout_branch`, read the real diff, judge each acceptance criterion; returns approve/request_changes/reject |
| researcher | `agent/subagents/researcher/` | Subagent | Fresh-context web research for facts the repo and tracker don't hold; returns cited findings + gaps |
| Linear access | `agent/connections/linear.ts` | Connection (MCP) | Create issues, comment, cross-reference; app-scoped auth via `linearAuth`; denied on unattended runs |
| User preferences | `agent/tools/{get,save,clear}_user_preferences.ts` + `agent/lib/user-preferences.ts` | Tools | Per-user standing preferences in Blob, keyed to the resolved principal (never model input) |
| Factory brain | `agent/tools/{read,update}_factory_brain.ts` + `agent/lib/factory-brain.ts` | Tools | Shared, durable notes about the target repository in Blob, keyed to `FACTORY_REPO` (never model input); reads open to every run, writes gated by `factoryBrainPolicy` (trusted-write) |
| Handoff artifacts | `agent/lib/artifacts/` + per-station `tools/{save,read}_artifact.ts` + root `agent/tools/read_artifact.ts` | Tools | Long Markdown documents stations pass by id in Blob: researcher and analyst save, analyst/implementer/reviewer read, the orchestrator relays only the id; ids validated by an anchored pattern so they can't escape the reserved prefix |
| Skills | `agent/skills/` | Skill | Load-on-demand procedures: `factory-pipeline`, `writing-quality`, `triaging-issues`, `github-linear-bridging`, `billing-triage`, `clarify-with-requester`, `slack-wording`, `triage-investigate`, `triage-policy` |
| Evals | `evals/` | Evals | eve eval runner: routing and safety assertions (deny-by-default over the write-tool list), an opt-in full-pipeline run |

Channels and the connection are I/O boundaries. Tools run in the app runtime (full `process.env`); the station git tools run their commands inside the station's sandbox. Skills only add instructions to context. Every station runs in **task mode** (its `agent.ts` declares an `outputSchema`), which means it returns structured output and can not request approvals or input; that is a design constraint, not an accident (see Security considerations).

## Data flow

1. **Unattended intake (`factory` label):** a maintainer labels an issue `factory`. The `issues` webhook hits `onIssue`, which dispatches only on the `labeled` action and only after verifying the labeler holds at least triage permission on the repository (GitHub fires `labeled` even for labels attached at creation, which issue templates let unauthenticated reporters do). The session's auth is rewritten to the constructed autonomous principal, and an injected task frames the run: never ask, post questions and stop if clarification is needed, deliver a draft PR. The autonomous principal resolves the full factory prompt inline, so the run never depends on the model remembering to load a skill. The pipeline runs; the orchestrator opens the draft PR (`draft: true` needs no approval) and announces it in the closing reply the channel delivers to the issue.
2. **Red CI on a factory PR:** a `check_suite` webhook with a failure conclusion, anchored to a pull request whose head branch starts with `factory/`, hits `onCheckSuite`. The session runs unattended on that PR's thread. The injected task self-limits: count earlier fix-attempt comments on the PR (each fresh session's only shared memory is the thread), stop and hand off to a person after 2, otherwise post an attempt comment, diagnose via `github__getCiFailureContext`, and run an implementer/reviewer revision that pushes to the same branch. Suites on branches people pushed never dispatch.
3. **Attended intake (@Foreman mention):** `onComment` keeps the built-in mention and ignore rules, dispatches only for OWNER/MEMBER/COLLABORATOR commenters, and stamps `attributes.trusted`. The session resolves the general prompt and loads the factory-pipeline skill for a real work item; the requester is on the other end, so clarifying questions go to them and GitHub writes run without approval cards.
4. **Linear sessions:** a user delegates an issue in Linear; `onAgentSession` stamps trusted, injects the requester's name, and (on a `created` event carrying an issue) injects the factory intake task as channel dispatch context, so the delegated issue runs the full pipeline. `prompted` continuations in the same session do not re-inject the task. The factory works the item, posts progress as Agent Activities, and reports the PR link back on the session. Cross-tracker conventions come from the `github-linear-bridging` skill.
5. **The pipeline itself:** the orchestrator grounds the work item (reads the real issue, dedupes via the `triaging-issues` skill), then delegates in order: classifier (text only) → optional researcher → analyst (reads its checkout) → implementer (branches, implements, verifies, `push_branch`) → reviewer (`checkout_branch`, judges the real diff). `request_changes` loops back to the implementer at most twice. Every delegation message is self-contained; stations never see the orchestrator's history. Long documents skip that inline path: the researcher and analyst can save a handoff artifact and return its id in `artifact_id`, the orchestrator relays the id, and downstream stations read the document themselves with `read_artifact`.
6. **PR opened (by someone else):** `onPullRequest` dispatches on the `opened` action (bot senders skipped, which covers `foreman[bot]`'s own PRs) with a summary task injected; the agent posts one orienting comment with a changed-files table.

## Data stores

- **GitHub** (external): the repository and issue tracker the factory works on. Tool access goes through `@github-tools/eve-extension` with credentials brokered by Vercel Connect; git access in station sandboxes authenticates at the sandbox firewall (see Security).
- **Linear** (external): where delegated work arrives and cross-references land. Access via Linear's MCP server with app-scoped Connect auth (scopes `read`, `write`, `issues:create`, `comments:create`).
- **Vercel Blob**: per-user preferences under the reserved `user-preferences/<hashed-principal>.md` prefix, reachable only through the principal-scoped preference tools; the shared factory brain under the reserved `factory-brain/<hashed-repo>.md` prefix, reachable only through the factory-brain tools; and handoff artifacts under the reserved `artifacts/<validated-id>.md` prefix, reachable only through the artifact tools. Authenticated by the project's OIDC token.
- **Vercel Sandbox**: the root sandbox holds the channel's thread checkout; each repo-facing station's sandbox holds its own clone of `FACTORY_REPO` (cloned once per template build via `factoryBootstrap`, moved to the current default branch per session via `factoryOnSession`). Not durable application stores.

There is no application database. Anything that must outlive a session (for example, cross-run sweep state for a future schedule) belongs in an external store.

## External integrations

| Integration | Purpose | Method |
| --- | --- | --- |
| GitHub | Label intake, mentions, and PR events in; comments, branches, and draft PRs out | eve GitHub channel + `@github-tools/eve-extension`, both via Vercel Connect (`GITHUB_CONNECTOR`); station git via firewall-brokered installation tokens |
| Linear (channel + MCP) | Agent Sessions in; issue creation, comments, cross-references out | eve Linear channel via Connect; MCP connection to `mcp.linear.app` with app-scoped auth shared through `linearAuth` (`LINEAR_CONNECTOR`) |
| Vercel Blob | Per-user preference storage, the shared factory brain, and station handoff artifacts | `@vercel/blob`, OIDC-authenticated |
| Vercel AI Gateway | Model access for the root and every station | Gateway model ids; the root model in `agent/agent.ts`, per-station models in each station's `agent.ts` (the reviewer deliberately runs a different vendor) |
| Vercel Sandbox | Isolated runtimes: root checkout + three station clones | `agent/sandbox.ts` and `agent/subagents/*/sandbox.ts` (`vercel()` backend, shared builders in `agent/lib/github/repo-sandbox.ts`) |

## Deployment & infrastructure

- **Platform:** Vercel. Deploy with `eve deploy` (wraps `vercel deploy --prod`; the raw command cannot auto-detect the eve framework).
- **Connectors:** provisioned via `vercel connect create` + `attach`; the GitHub trigger points at `/eve/v1/github` (subscribe to `issues`, `issue_comment`, `pull_request_review_comment`, `pull_request`, and `check_suite`) and the Linear trigger at `/eve/v1/linear` (AgentSessionEvent). The GitHub App installation needs write access to contents, issues, and pull requests on `FACTORY_REPO`.
- **Environment:** connector UIDs `GITHUB_CONNECTOR` and `LINEAR_CONNECTOR`; `FACTORY_REPO` (required at module load; a missing value fails discovery); optional `FACTORY_SETUP_COMMAND` (runs inside the clone at template build). The model and Blob authenticate via the project's OIDC token.
- **Local development:** `pnpm dev` runs the same runtime in a TUI; `vercel env pull` supplies a short-lived OIDC token (needed for Connect and the station sandboxes). The webhook surfaces run against a deployment. The dev principal is untrusted by design, so approval cards surface in the TUI.

## Security considerations

- **Trust is decided at dispatch, not in the prompt.** The channel hooks decide who the caller is on the signed webhook and stamp it into session auth (`attributes.trusted`, or the constructed autonomous principal). `agent/lib/trust.ts` is the single authority reading those stamps; a new capability never invents its own caller check.
- **Approval predicates gate non-GitHub surfaces.** GitHub tools have no approval gates; the remaining policies (`factoryBrainPolicy`, `modelSwapPolicy`, `denyAutonomousWrites`) gate the factory brain, model swaps, and connection writes. Unattended runs are denied rather than left waiting: nobody is watching to answer, and a server-side denial costs one step instead of a stranded session.
- **Merge is excluded from the tool surface.** No merge tool is in the allowlist, and GitHub writes run without approval cards.
- **Stations run in task mode and therefore hold no approvable tools.** A task-mode child cannot park, so nothing inside a station may need one. The implementer's `push_branch` is safe ungated because it is inert by construction: `validateBranch` refuses `main`/`master`, `refs/*`, `HEAD`, and anything outside a conservative character set (so shell metacharacters can't reach the command line), and a feature branch alone ships nothing.
- **Git credentials never enter a sandbox.** Clones, fetches, and pushes target the literal `https://github.com/<FACTORY_REPO>.git` URL, never the model-writable `origin` remote, and the installation token is injected at the sandbox firewall as a header transform on egress to github.com (`brokerPolicy`), dropped again in a `finally`.
- **Label intake can't be forged by reporters.** GitHub fires the `labeled` action even for labels attached at issue creation, which issue templates let unauthenticated reporters do, so the hook verifies the labeler's repository permission against the API before dispatching; anyone below triage is acknowledged without a session.
- **Mention authorization:** `onComment` dispatches only for OWNER/MEMBER/COLLABORATOR commenters; everyone else's mentions never start a session. The PR-opened hook deliberately isn't association-gated (summarizing outside PRs is the feature) but its task is scoped to one summary comment, and the dispatched session carries no trusted stamp.
- **Clarification prompts on GitHub:** the channel posts clarifying questions as comments by default, with a mention-based reply instruction. The channel's `botName` is fed the connector-resolved name, which keeps that instruction and the reply's mention-stripping correct. Answers route back through the same `onComment` mention gate, which is what makes a comment reply an authorization signal rather than a race anyone on a public repo can win: an untrusted account's reply never reaches the waiting session.
- **Prompt-injection surface:** the factory reads third-party issue bodies, comments, and diffs, and its stations execute repository code (tests, lint) inside sandboxes. The bounds are structural: unattended sessions run under the denied-by-default autonomous principal, the Linear connection denies unattended writes, sandbox egress for station git runs under the firewall policy, and merge tools are excluded from the surface entirely. Instruction-following on injected text remains model judgment; the evals' prompt-injection case keeps a floor under it.
- **Inbound route auth** (`agent/channels/eve.ts`): `[localDevUser, vercelOidc()]` rejects public browser traffic; channel traffic is authenticated by each connector.
- **Per-user isolation:** the preference tools derive their Blob key from the resolved principal, never from model input; files live under the reserved `user-preferences/` prefix. `clear_user_preferences` is approval-gated (`always()`).
- **Shared-brain integrity:** the factory-brain tools derive their Blob key from `FACTORY_REPO`, never from model input, so a session can't redirect a read or write to another object. Reads are open, but `update_factory_brain` is gated by `factoryBrainPolicy`: unattended runs are denied so an untrusted issue body can't write into the context every future run reads, trusted callers write directly, and the dev TUI waits on an approval card.
- **Artifact-id containment:** artifact ids are the one Blob address the model supplies, so `artifactKey` accepts only ids matching the anchored `ARTIFACT_ID_PATTERN` (lowercase alphanumerics and hyphens, no dots or slashes) before interpolating them into a key under the reserved `artifacts/` prefix; an invalid id reads as `found: false`, indistinguishable from a missing one. Saves never overwrite (`allowOverwrite: false`), are size-bounded, and mint their own suffixed id, which is what lets both artifact tools live ungated inside task-mode stations.

## Development & testing

- **Runtime/TUI:** `pnpm dev` (eve dev TUI; `/model` links a provider).
- **Type checking:** `pnpm typecheck` (tsc).
- **Lint/format:** `pnpm check` / `pnpm fix` (Ultracite, a Biome preset; config in `biome.jsonc`).
- **Discovery diagnostics:** `npx eve info` (must report 0 errors / 0 warnings).
- **Evals:** `pnpm eval --tag fast` for the cheap loop; `pnpm eval pipeline/full-pipeline` deliberately runs the whole line and pushes a real branch (scratch repo recommended). Evals cost real model tokens.
- `pnpm validate` bundles check + typecheck + `eve info`.

## Future considerations

- **Continuous operation:** a sweep schedule (handler mode, one dispatched session per queued item) needs cross-run dedupe state, which needs an external store; the approval policies already recognize schedule turns via `isScheduleAppAuth`.
- **Merge behind approval:** add `mergePullRequest` to the extension's allowlist with an approval policy for comment-driven merges, if ever wanted.
- **More intake:** `onCheckRun`/`onWorkflowRun` (finer-grained CI intake), Sentry via an MCP connection on the analyst, Slack via eve's Slack channel.
- **Per-caller tool surfaces:** today the caller class changes approval outcomes, not which tools are mounted; extension-level dynamic tool surfaces would trim schema tokens for untrusted sessions.
- **Parallel tracks:** for large items, the analyst could split independent tracks and the orchestrator could fan out several implementer calls in one response (eve runs the batch concurrently), with non-overlapping write scopes.

## Glossary

- **eve:** the agent framework powering this app; discovers capabilities from `agent/`.
- **Channel:** an inbound/outbound surface. Here: GitHub, Linear, plus the eve route's auth config.
- **Connection:** an external MCP/OpenAPI server exposed to the model. Here: `linear`.
- **Extension:** a prebuilt eve package mounted at `agent/extensions/<ns>.ts`; its tools appear as `<ns>__<tool>`. Here: `github` (`@github-tools/eve-extension`).
- **Tool:** a typed action authored with `defineTool`, run in the app runtime. Station tools run their commands in the station's sandbox.
- **Skill:** a load-on-demand Markdown procedure; the packaged form requires `description` frontmatter used for routing.
- **Dynamic instructions:** instructions resolved at runtime from session context (here, the caller) via `defineDynamic` on `turn.started`, instead of a static prompt.
- **Dynamic skill:** a skill resolved at runtime via `defineDynamic` on `turn.started`; here, `factory-pipeline` is advertised to interactive sessions only (autonomous sessions inline `PIPELINE`).
- **Channel dispatch context:** extra context a channel hook injects alongside auth when it dispatches a session (here, the GitHub intake task and the Linear intake task).
- **Subagent / station:** a declared agent under `agent/subagents/<id>/` the root delegates to as a tool. It runs in a fresh child session and inherits nothing from the root (no instructions, tools, connections, or sandbox), so the caller passes everything in `message`. An `outputSchema` on its `agent.ts` makes every call task mode: structured output, and no stopping to wait for input.
- **Task mode:** a child session that must run to completion and return structured output; it cannot ask questions or wait on approval.
- **Autonomous principal:** the constructed identity (`github:foreman-factory`) unattended label-intake runs execute under, carrying the intake issue number as an auth attribute.
- **Vercel Connect:** brokers OAuth/credentials for GitHub and Linear; connectors are identified by a UID.
- **OIDC:** the project's Vercel identity token, used to authenticate Blob (and AI Gateway) without static keys.
