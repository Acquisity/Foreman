# Foreman architecture

Company MCPs and authored provider helpers use one app-scoped Executor toolkit, `Foreman`. Root, native delegates, critic, and schedules share the same provider access; skills define workflow behavior and the critic remains instructed to review read-only. The toolkit manifest and exact operation bindings live under `.github/executor/`. Personal Supermemory and inbound delivery, storage, models, and sandbox infrastructure remain separate.

Foreman is a repository-neutral Eve 0.54.2 agent with one general execution path. The upgrade pins AI SDK 7.0.97 and the GitHub extension 0.7.1.

## Routing

`agent/lib/prompts.ts` composes one general prompt for every interactive channel. The root handles repository changes directly and may delegate independent work through eve's native `agent` tool. Critic and vision remain declared children for triage review and image reads. GitHub starts work only for trusted mentions; factory labels, CI events, reviews, synchronizations, and PR opens do not dispatch work.

## Repository binding

`agent/lib/repository.ts` validates repository slugs, extracts explicit targets, stamps signed channel context, derives literal remote URLs, and reads the prepared workspace marker.

- GitHub hooks stamp the signed webhook repository as `github-webhook`; it is authoritative.
- Slack, Linear, and eve stamp an explicit repository only when the message names exactly one, and only by full GitHub URL.
- `prepare_repository` refuses missing, ambiguous, and conflicting targets. It reuses `/workspace` after GitHub channel checkout or clones to `/workspace/repo` at runtime.
- An attended session may prepare a different validated repository later, and the checkout is replaced rather than the request refused. The old checkout is set aside to a tool-owned path first, so a clone that fails, times out, or is refused puts it back and keeps the marker it had. A rollback that itself fails clears the marker, and the session is left with no repository prepared. An interrupted switch is settled by the published checkout's own origin before either reuse or a switch trusts the marker. A signed GitHub checkout, an unattended run, and a checkout at `/workspace` are never replaced. A refreshed checkout reinstalls dependencies only when the repository's lockfile moved between the old and new HEAD, or when its install state is unknown. Every refusal returns `success: false` with the reason and leaves one bounded warning behind.
- GitHub extension calls supply `owner` and `repo` explicitly. The extension has no fixed context.
- The repository tools and the GitHub tool surface are resolved per lane by `agent/lib/repository-lane.ts`. A session with no selected repository, and no repository prepared carries neither; a repository-selected lane carries both, and a session that prepares a repository at runtime carries them from the next step of that turn. `prepare_repository` and `rebuild_warm_snapshot` stay static, because the first is how a lane names a repository at all; the slug it records lives in `agent/lib/repository-selection.ts`. The gate is catalog composition, not authorization: trust, approval, the intake-only denials, and signed webhook binding are unchanged by it.
- Native root-agent copies and vision share the root sandbox. Critic has its own sandbox and can check out the exact commit for independent evidence review.

Every clone, fetch, and push targets `https://github.com/<validated-owner>/<validated-repo>.git` literally. Installation credentials are injected by `brokerPolicy` at the sandbox firewall and removed in `finally`. `validateBranch` rejects protected or non-plain branch names; it is the whole gate, so `push_branch` delivers a human branch name such as `afragahaha/eng-13319` unchanged.

## Delegation and delivery

Native `agent`, critic and vision launches return working receipts with task and child IDs. Those receipts admit background work; they are not completed findings. Eve delivers later child results to the parent, grouping successful results from overlapping tasks when that group settles. Later user turns and another round of delegation use this same native delivery. The root adjudicates the returned evidence and finishes dependent work. There is no authored polling loop or task tracker.

Native children inherit the root's configuration and sandbox with fresh history and state and cannot delegate recursively. Send self-contained tasks and avoid overlapping edits. Critic keeps its own tools, skill and independent sandbox. Vision shares the root sandbox, carries only `read_image`, and disables shell, file, web, todo and question defaults. Root and critic also disable `ask_question`.

The root owns feature-branch and pull-request delivery. There is no station protocol, artifact handoff, automatic stabilization, or readiness state machine. Repository authority, protected branches, intake-only denials, and the human merge boundary remain enforced.

The browser extension uses a temporary exact-version pnpm patch containing the upstream 0.37.1 distribution rebuilt for Eve 0.54.2. Browser behavior and the 21-tool surface stay unchanged. This is a removable compatibility measure: prefer a verified official release and remove the patch when one passes the same build and live Preview checks. Build provenance and removal instructions are in [EVE-BROWSER-REBUILD.md](./EVE-BROWSER-REBUILD.md).

## Channels and trust

- GitHub verifies Connect-forwarded webhooks. Mentions dispatch only for owners, members, and collaborators. Signed repository context is stamped before any model step.
- Linear Agent Sessions are trusted by workspace membership. A `created` event with an issue adds only requester attribution; `prompted` continues the existing session.
- Slack mentions are trusted by channel membership.
- The Eve HTTP channel uses local dev or Vercel OIDC auth, and stamps a single URL-named repository from the delivered message like the other interactive channels.

`agent/lib/trust.ts` is the sole caller-trust authority. Unattended runs are denied writes to shared repository knowledge, global model configuration, and personal Supermemory. For repository knowledge and model configuration, trusted attended callers write directly; other attended callers receive approval prompts. Company services share the same Executor catalog across attended and unattended workflows; workflow instructions govern their use.

Investigation-memory access is a separate, narrower stamp on the same authority. Linear Agent Sessions, every Slack surface the app is invited into, and the local dev TUI carry it; GitHub sessions and schedules never do. It is fail-closed: an unstamped session reads nothing.

Autumn and Stripe billing helpers use the shared company account through Executor on every workflow. They retain fixed read operations, identifier validation, bounded history, and field filtering; they expose no billing writes and require no requester-specific provider consent.

## Slack continuity and cancellation

Slack queues later mentions and preserves each request's auth stamp. Reasoning deltas accumulate in per-turn/per-step channel state and clear at lifecycle boundaries. Progress remains limited to one line at five minutes and one at fifteen minutes, with intake-only sessions quiet and terminal events clearing state.

A literal stop/cancel resolves the exact durable session and requests `cancel({ turnId, tasks: true })`, retaining the latest turn ID even while the parent waits on children. One idempotent "Stop requested." acknowledges acceptance; it does not claim child termination. Native background-task cancellation can settle without a parent `turn.cancelled` event, so runtime verification observes child streams.

When an existing Slack thread has no active Eve session, dispatch restores earlier visible messages through the last bot reply using Eve's public history helper. Native lookback supplies the messages after that reply. The added prefix is capped at 32,000 characters, drops whole oldest messages and identifies truncation or unavailable history. The helper reads at most the first 50 replies. This is untrusted context, never fresh authorization or restored tool results, internal notes or sandbox files. Version cutover retires old internal sessions after work drains while keeping the Slack threads; the reset and rollback checks are in [UAT-BATTERY.md](./UAT-BATTERY.md).

## Scheduled support lifecycle

Each support lease starts a conversation session, allowing later critic/vision results to reach its root. Ordinary parent-turn completion does not settle the investigation. Explicit finish/quiet/skip actions retain the existing revision, review, journal and delivery checks. Root turn failures and terminal session failures use the claim seeded into auth and persisted channel state; child failures cannot release the root lease.

One public durable state value counts at most 150 root model steps across turns, deduplicating retries, under the original eighteen-minute deadline. Support-only hooks reject input and authorization waits on the root, native delegates, critic and vision. An unfinished first intake gets the existing incomplete notice on the next claim after its twenty-minute lease expires; pending outboxes reconcile first, repeated identical notices are suppressed and unchanged follow-ups stay quiet. Dormant conversation sessions use Eve's default thirty-day lifetime from creation. Provider calls and writes remain fenced by the much shorter support lease. See [INTERCOM-SUPPORT-CRON.md](./INTERCOM-SUPPORT-CRON.md).

## Storage

Active Blob namespaces are registered in `agent/lib/blob.ts`.

- `repository-knowledge/<repository-hash>.md`: verified shared facts. Reads fall back to legacy `factory-brain/<repository-hash>.md`; trusted writes always use the new namespace.
- `model-overrides/foreman.json`: global model overrides used at session start.
- `user-preferences/<principal-hash>.md`: private principal preferences.

Supermemory is available for broader attended-session recall, never as repository authority or autonomous shared memory, and never the backing store for investigation memory.

Investigation memory is a private Foreman-owned Postgres database, separate from Blob, from Acquisity production data, and from the read-only Neon tools reached through Executor. `FOREMAN_MEMORY_DATABASE_URL` is server-side only. `migrations/` holds the schema, applied explicitly with `pnpm db:migrate`, never at agent startup. Retrieval is authorized by the investigation-memory session stamp and searches the server-owned live product areas without reading or accepting Linear project metadata. Incoming missing, unmapped, or generic intake projects therefore cannot block recall or determine routing. Each settled investigation, whether its source is a Linear ticket, an Intercom conversation, or a Slack thread, has one active revision, scoped by the tenant key plus one primary feature: derived from the evidence-backed Linear project saved during final handling when there is a ticket, named directly from the live areas when there is not, with affected features and dependency keys alongside it. The searched text includes the resolution and the ruled-out conclusions, so a case a colleague corrected in a thread is found by the fix it recorded and by the theory it overturned. Corrections insert a new revision and supersede the old one in the same transaction; nothing is deleted, so a ticket accumulates rows and exactly one of them is active. Rows are meant to carry sanitized patterns only. The tool boundary enforces what a pattern can enforce, and only over free text: bounded lengths, and rejection of email addresses, organization and user ids, connection strings, and credential-shaped tokens. The evidence fields are deliberately looser, because the identifier rule cannot tell an organization id from a Sentry request id or an Inngest run id: evidence handles, error signatures, code paths, and symptoms accept opaque identifiers, while the prose that describes the customer's situation does not. The source and document links are bounded, must be https, and must carry no userinfo; beyond that they are only shape-checked. They point at our own Linear, Intercom, and Slack and are written by an authorized attended session, so there is no adversary to harden them against, but a credential-bearing link is still a credential and is refused like any other. Nothing there recognizes an arbitrary production row or log line, so keeping those out is the triage procedure's job, and they belong in the ticket's `Triage investigation` document. `agent/lib/investigation-memory/` owns the taxonomy, the schemas, and the store.

## Verification

Every Foreman-authored outside call is inventoried in [OUTSIDE-CALLS.md](./OUTSIDE-CALLS.md). `pnpm validate` checks generated specs, Ultracite, TypeScript, `eve info`, and unit tests. `pnpm report:capabilities` reads manifest version 48, distinguishes framework defaults through compiled owner bindings, and measures each declared child's actual prepared delegation description and schema. It checks three lanes and admits GitHub dynamic tools through Eve's real preparation before counting them; all 31 must survive. Ordinary Slack must carry no more than 75% of the repository catalog. The compiled catalog must retain exactly critic and vision as declared children.

`pnpm verify:built-github` boots the actual server and reads its registered compiled module map, including the GitHub extension inlined by Eve 0.54.2. It verifies the exact 31-tool allowlist and all 31 execute, approvalRequest and toModelOutput callbacks, mounted lane gates, distinct approval policies and an unstamped negative fixture.

Evals cover direct questions, clarification, repository/model approvals, prompt injection, native delegation, and opt-in scratch delivery. Build and discovery do not prove runtime dispatch: run [UAT-BATTERY.md](./UAT-BATTERY.md) on the exact Preview commit, including attachments, intake restrictions, critic, native children, cancellation, and real provider reads. Configure the current PR's Preview trigger and Executor environment before testing. Production rollback is a revert on `main`, never `vercel rollback`.
