# Foreman-authored outside calls

Every call Foreman itself writes that leaves the process, and the deadline it runs under. Recorded by ENG-13318 (northstar P8.4), which closed the gaps P8.1 to P8.3 left.

Eve framework-owned traffic (model provider requests, MCP connection traffic, channel delivery, workflow and queue steps) is deliberately absent: eve owns those deadlines, and P8 does not reach into them.

A new outside call belongs in this table. This document is the record; the table below is what has to be kept true.

`agent/lib/outside-call-bounds.ts` is a small guard, not a completeness check. It is not a TypeScript parser and does not claim to find every outside call. It knows four literal call spellings, finds each by name across the authored non-test TypeScript under `agent/`, and reads that call's own argument list by matching parentheses, so a bound removed from one call is caught even when the call beside it keeps one:

- a `.run(` outside `agent/lib/sandbox-deadline.ts`, because `boundedRun` is the only `.run(`-spelled sandbox command path; `agent/lib/repository-snapshot.ts` uses `runCommand` and is bounded separately by the sandbox's own timeout
- a `fetch` or `fetchImpl` call whose argument list carries no `signal`
- a `head`, `put`, `del`, or `get` call in a file that imports `@vercel/blob`, with no `abortSignal`
- a `neon` client built with no `fetchOptions` signal

It does not see anything else, and none of these are gaps to be closed by growing it: a call reached through an alias or a variable, a call assembled inside a template expression, a provider it has never been told about, and the same four spellings written inside a comment or a string, which it reads as live code. Adding a provider means adding its spelling and its bound, or accepting that only this table records it. `agent/lib/outside-call-bounds.test.ts` carries a mutation case per rule, each one the real current source file with a single bound removed, so the guard is checked to fail rather than assumed to.

`agent/lib/sandbox-deadline.test.ts` covers the shared sandbox helper, including the races between a cancellation and the deadline.

## HTTP requests

Billing, Instantly, Inngest, Linear, and help-center helpers call an injected typed Executor client with operation identifiers and validated arguments. Their existing provider deadlines, result-size caps, and response filters remain active around that client. Every authored operation enters `agent/lib/executor/dispatch.ts`; only its internal `agent/lib/executor/transport.ts` wire adapter performs their outbound HTTP requests. The bounded PlanetScale query uses that same transport, then applies its existing result truncation. All helper invocations use a fresh MCP session, reject redirects, cap the transport response at 8 MiB, and reject paused executions instead of resuming approvals.

| Call | Bound | Notes |
| --- | --- | --- |
| `agent/lib/widget-judge.ts` (`judgeAnswer`, replay and `scripts/widget-judge.ts rerun`) | 60s per judge call, composed with caller cancellation | ENG-14686. Replay makes one structured gateway call per answered case; rerun makes two per gold sample (two full passes), with the scrubbed cassette as ground truth. The deadline covers response generation and SDK retries; operator calibration calls have the same bound even without a caller signal. Failures never become yes verdicts. |
| `scripts/widget-case-from-run.ts` workflow inspection and case formatting | 180s per subprocess | Operator-only `@workflow/cli@5.0.1 inspect` reads from the local backend or fixed Acquisity Foreman Vercel target; production decryption is an audit-logged key retrieval. stdout is bounded to 256 MiB and raw streams stay in memory; only leak-checked cases reach disk. The Biome formatter subprocess uses the same deadline. |
| `scripts/widget-candidates.ts` run store read and converter subprocess | 30s per private Postgres SELECT via `privateDatabase`; 900s per converter subprocess | ENG-14750. Operator-only, read-only. SELECTs on `widget_support_runs`, paged by whole conversations (at most 5,000 rows per page; an oversized single conversation is refused without advancing the cursor) against the URL the operator points `FOREMAN_MEMORY_DATABASE_URL` at; each flagged `wrun_` session without an existing pending case then runs `scripts/widget-case-from-run.ts` with its own 180s bounds, so the subprocess bound covers its four CLI calls. The converter writes directly to `cases-pending/`; fixed failure classes reach the terminal while diagnostics stay in `.eve/widget-candidates/`. Transient failures are durably queued for retry; leak refusals are terminal. Raw customer text goes only to the gitignored `.eve/widget-candidates/`. |
| `scripts/executor-readiness.ts --live` | 20s per GET | Operator-only toolkit, policy, and connection-pattern metadata from the fixed Acquisity Executor API; redirects refused. Uses the selected local OAuth profile without requesting provider credentials or printing tokens. |
| `agent/lib/executor/transport.ts` | 50s for handshake and invocation, composed with the caller and provider deadline | Covers body streaming; 8 MiB cap; redirects refused. Provider helpers below impose their tighter existing deadlines. |
| `agent/lib/billing-api.ts` (Stripe, Autumn) | 20s per request | ENG-13315. Composed with the caller's signal; the failure is classified from the composed signal's first abort reason, so a late caller abort cannot turn a timeout into a cancellation. |
| `agent/lib/instantly-api.ts` | 15s per request | ENG-13316. The deadline covers the complete typed call, including MCP response streaming in Executor transport; provider retries begin only after the prior invocation has settled. |
| `agent/lib/linear-api.ts` | 15s per request | Composed with the caller's signal. |
| `agent/lib/inngest-api.ts` | 15s per request | Composed with the caller's signal; a caller abort rethrows unwrapped. |
| `agent/tools/widget_outreach_health.ts` live campaign read | 20s for the complete scan, composed with turn cancellation; existing Instantly 15s per request | At most three pages through the existing helper, exact saved campaign ID in the verified provisioned workspace. Saved evidence survives live-read failure. |
| `agent/lib/widget-app-diagnostics.ts` | 25s including response streaming, composed with turn cancellation | Fixed Acquisity website routes; dedicated server credential, trusted conversation scope, redirects refused, 64 KiB response cap. App rechecks current membership and resource permissions. |
| `agent/lib/widget-website-network.ts` DNS and HTTPS | 8s total, composed with turn cancellation; DNS resolver 2s/one try and cancelled at deadline | Only a currently assigned domain of an owned website. HTTPS pins a validated public address, bounds headers to 16 KiB, follows no redirects, sends no credentials and reads no response body. |
| `agent/channels/linear.ts` follow-up gate (Linear thread read, Jev) | 7s for the whole gate | ENG-14324. Runs before a relayed Slack follow-up reaches the model. The Linear read takes no signal, so the gate races a 7s deadline that also aborts the Jev call; a timeout or any failure dispatches the session as usual. |
| `agent/channels/linear.ts` widget-feedback route (Linear issue read in `agent/lib/widget-feedback.ts`) | 7s | ENG-14332. Reads the issue's project and description to tell a chat widget feedback ticket from every other issue, in parallel with the follow-up gate. The read takes no signal, so it races a 7s deadline; a timeout or any failure keeps today's triage route. |
| `agent/channels/linear.ts` 'Ask from' read (Linear issue attachments) | 7s, in parallel with the follow-up gate | ENG-14588. Runs before every created or prompted Linear session so the context names the intake requester rather than the session opener. The read takes no signal, so it races the same 7s deadline; a timeout or any failure falls back to the opener line. |
| `agent/lib/jev.ts` (`askJev`, including prior-work, incident, and reply grounding decisions) | 15s for token lookup and the gateway request, including response streaming | Composed with the caller signal. Reply grounding returns the unchanged draft on failure or timeout; caller cancellation still throws. |
| `agent/lib/help-center.ts` | 10s per request | Composed with the caller's signal. A failure returns `error` rather than throwing, because search is advisory. |
| `agent/lib/widget-router.ts` | Front door: 4s first request, 3s fallback request; investigation change check: 5s | ENG-14932. Jev scores only human, refund and ticket requests, bug reports and recording offers, composed with caller cancellation. It neither chooses articles nor writes replies. A timeout, network error or overloaded or failing provider retries the same questions once after 300ms; failure or a missing key scores everything zero, leaving the guide lane (or, with `WIDGET_CHAT=legacy`, the help-center writer) to answer. Only explicit investigate mode, a teammate or an owner's recording starts an investigation. The separate `asksForChange` call runs only at the end of an investigation. Conversation text is Foreman's previous reply (its last 2,000 characters) followed by the latest message (its first 4,000), screenshot readings and bounded earlier turns, capped at 17,000 characters. |
| `agent/lib/widget-kb.ts` (public retrieval and the help-center writer, the front door only with `WIDGET_CHAT=legacy`) | 45s for the whole help-center answer; 5s per index or search fetch; article content read: 10s; screenshot download: 5s per image | ENG-14932. Reads the public article index, selects up to four articles with a gateway model, and reads their content (8,000 characters each). If the index is unavailable or selection fails or yields none, a gateway query rewrite feeds public lexical search. Up to two validated previously cited articles remain context. One gateway writer answers the visible conversation using those articles and verified workspace name, role and investigation availability, without account reads or tools. Selection, rewrite and generation share the 45s deadline; a model call still pending at 4s is hedged with one identical call, and a failed first call starts the hedge immediately. Screenshot loading shares that deadline, reads at most three images with a 3 MiB cap each and refuses redirects. Text answers use `kb`, image answers use `kbImages`, and selection uses `kbSelect`; there is no Jev article-decision call. |
| `agent/lib/widget-kb.ts` (`ground`, the check after the writer) | 8s, inside the 45s help-center deadline | ENG-14932. One `kb` gateway call, hedged at 4s like the writer's, receives the visible conversation, the writer's reply, the same numbered articles and the few facts the reply prompt itself supplies, and returns the reply with unsupported Acquisity claims removed or softened. When the trimming removed the answer itself (`stillAnswers` false), the same call's short honest reply with a next step is sent instead, citing nothing. It never blocks: a failure, timeout or empty result sends the writer's reply as written. Logs `widget.kb.ground` with changed, replaced, unchanged or fallback and its ms, never reply text. |
| `agent/lib/widget-chat.ts` (the guide lane, the front-door chat unless `WIDGET_CHAT=legacy`) | 20s for the whole reply, composed with the turn signal; hedged at 4s with one identical call | ENG-14932. One streamed `kbChat` gateway call (google/gemini-3.6-flash, Google AI Studio first, or `WIDGET_CHAT_MODEL`) with the generated product guide in a stable system prefix, then the app's role note and the visible conversation. No account data and no account tools. It starts while the router scores the message and is aborted when the router hands off or redirects. A failure or timeout returns a fixed ask to send the message again. Logs `widget.chat.answer` with model, time to first token, total ms, input and cached tokens and citation count, never reply text. |
| `scripts/widget-product-guide.ts` (operator-only guide generation) | 60s per `git` subprocess; 240s per gateway call, raced, three tries each | ENG-14932. Reads the Acquisity docs at a given ref with `git archive` from a local checkout and changes nothing there. About 55 `claude-sonnet-5` distill calls (six at a time) and one `gemini-3.5-flash` navigation call; a cut-off call fails the run instead of dropping articles. Writes `agent/lib/widget-product-guide.ts`, which must be regenerated after help-center changes ship. |
| `agent/lib/widget-screenshot.ts` (attachment reading) | 20s per model request, composed with caller cancellation | Reads an attached image through the `vision` gateway model before the message is sent. At 4s, or immediately on primary failure, races one flash-lite backup; the winner aborts the loser. Accepts PNG, JPEG, GIF or WebP up to 3 MiB. The authenticated request verifies widget scope first using the existing context-read bounds. |
| `agent/tools/widget_file_ticket.ts` (`isRefundTicket`) | 3s per request | ENG-13999. Before a widget ticket is filed, Jev decides from the ticket's own title and summary whether it asks for a refund; a refund goes to the Support project with the Refund label, assigned to the billing owner. Sends only that title and summary. Any failure or a missing `AI_GATEWAY_API_KEY` files the ordinary Engineering ticket. |
| `agent/lib/widget-review.ts` | 10s per request | JEV item-level widget review through Vercel AI Gateway (`AI_GATEWAY_API_KEY`). At most 60 numbered items and 60,000 state characters; no silent truncation. Missing, malformed, uncertain or failed review blocks. Deterministic ownership checks and reply composition are unchanged. |
| `agent/lib/widget-next-action.ts` | 3s per request | ENG-13999. Only when `WIDGET_NEXT_ACTION=jev`. Jev picks the widget investigator's next action after each tool result, composed with the model call's abort signal. Sends the same conversation format as the router (12,000 characters), this turn's tool calls and results (48,000 characters in total, cuts marked) and the remaining allowlisted tools with their descriptions (1,500 characters each); never model reasoning. The same bounded request asks once more at the finish, only when the findings ask for a person, whether the customer asked for one or billing needs reconciling, sending the conversation and the findings' claims and recommendation; if that fails the findings stand. A timeout, bad status, missing key or answer off the menu leaves the step to the existing budgeted investigation and is logged as a fallback. |
| `agent/lib/planetscale.ts` | 50s via Executor | Result parsing and truncation remain local; oversized transport responses fail with a bounded error. |
| `agent/lib/executor/sentry.ts` (`read_sentry_issue`) | 50s via Executor | Strict input permits issue details and event search only; output is capped at 100,000 characters after transport parsing. The underlying dispatcher is also available through the shared toolkit; critic instructions require read-only review. |
| `agent/subagents/vision/tools/read_image.ts` | 20s | Covers the body read; the signal is passed to `fetch`, so a stalled download aborts with it. One 20s reader deadline covers the whole read, armed once and raced by every chunk, and the same reader bounds the sandbox path branch, which no signal reaches (see the sandbox file I/O note below). |

## Other clients

| Call | Bound | Notes |
| --- | --- | --- |
| `agent/lib/investigation-memory/store.ts` | 15s per operation | ENG-13318. The Neon serverless driver sends each query as its own HTTP request and enforces no deadline. The client is built per operation, not cached: a cached one would hold an already-fired signal and refuse every later query. Several queries inside one exported function share the bound. |
| `agent/lib/blob.ts` | 20s per operation | ENG-13318. `@vercel/blob` retries internally but sets no overall deadline. |

## Intercom support schedules

| Call | Bound | Notes |
| --- | --- | --- |
| `agent/lib/support/store.ts` | 15s per query | Private operational tables, atomic leases and write journal. No customer database or investigation-memory reads. |
| `agent/lib/slack-requester.ts` | 10s for the whole lookup, token resolution included; the response is read under a 200,000-character cap and cut off past it | One fixed Slack `users.info` read on the signed author id, only for questions-only channels at dispatch. Any failure, including missing `users:read.email`, returns an unknown requester; nothing is logged. Slack token resolution uses the Connect exemption below. |
| `agent/lib/support/slack.ts` | 20s per HTTP request; at most 10 history pages per tick | Fixed Slack channel and methods. Intake checkpoints descending timestamp bounds after discoveries, advancing the oldest watermark only when the gap is complete. Thread reconciliation requires a complete bounded scan. Slack token resolution uses the Connect exemption below. |
| `agent/lib/executor/dispatch.ts`, `agent/lib/executor/transport.ts` | 50s after authorization | Support operations and schema discovery reuse the existing bounded Executor transport. Lease is checked before dispatch. |

## Sandbox commands

All of these run through `boundedRun` in `agent/lib/sandbox-deadline.ts`, which returns exit code 124 rather than throwing, so each caller's existing non-zero branch handles a deadline. A cancelled turn still throws, which is what keeps cancellation distinguishable from a timeout.

A caller that passes its own `abortSignal` keeps it: the helper composes the caller's signal with the deadline rather than replacing it, so an already-aborted caller signal still cancels the command. The failure is classified from the thrown reason, not from the local signals. eve wraps a second composition around whatever it is handed and folds the session's own cancellation into it (`bindSandboxAbortSignal`, `eve@0.44.0`), so a session cancellation can win a race the helper cannot see on its own signals; only what the command rejects with names the winner. The helper arms its deadline with its own reason object and reports exit 124 for that reason alone, so a cancellation whose rejection arrives after the deadline expired still throws.

| Call | Bound | Notes |
| --- | --- | --- |
| `agent/tools/prepare_repository.ts` | 300s per command | ENG-13317 bounded the clone, refresh, install, publish, and discard. ENG-13318 bounded the five local probes it left: worktree detection, origin read, the occupied and warm-checkout probes, and the git identity write. A deadline on the occupied probe refuses instead of publishing over a path it could not read. ENG-13320 bounded the four commands a repository switch adds: the lockfile diff, the set-aside and restore renames, and the marker discard. A deadline on the lockfile diff installs rather than assuming the dependencies held still. |
| `agent/tools/checkout_branch.ts`, `agent/tools/push_branch.ts` | 300s per command | ENG-13318. |
| `agent/subagents/critic/tools/checkout_commit.ts` | 300s per command | ENG-13318. |
| `agent/sandbox.ts` `onSession` | 300s | ENG-13318. A deadline surfaces as the existing non-zero branch, which throws and fails the session rather than hanging it. |
| `agent/lib/repository-snapshot.ts` | 800s for the whole build | The sandbox itself carries `timeout: BUILD_TIMEOUT_MS`, so every command inside is bounded by the sandbox's own death, matched to eve's Vercel invocation ceiling. |

## Exemptions

Each of these is a call Foreman makes with no deadline, for a stated reason.

### Vercel Connect

`mintInstallationToken`, `getConnectorMetadata` in `agent/lib/github/bot-name.ts`, the `userConnect` path in `agent/lib/user-connect.ts`, and Executor app authorization through `agent/lib/executor/auth.ts` and `agent/lib/managed-connect.ts` all go through `@vercel/connect`. The Executor transport's 50-second deadline starts after authorization. Provider-specific timers may already be running, but their signals cannot cancel that SDK token lookup.

`ConnectOptions` (`@vercel/connect@0.8.0`, `dist/token.d.ts:92`) carries only `vercelToken` and `forceRefresh`. There is no signal, no timeout, and no other cancellation surface, so there is nothing to bound. Racing a timer against the promise would report a failure while the request kept running, which is worse than waiting. Revisit when Connect exposes a signal.

### Native Slack history, retirement and acknowledgement

`agent/lib/slack-history.ts` calls the public `loadThreadContextMessages` helper only for a reply in a Slack thread that has no existing Eve session. It reuses Eve's thread refresh, which requests one page of 50 replies, and caps the added context at 32,000 characters. The public helper and native Slack request surface expose no authored abort signal; token resolution uses the Connect exemption above. These are result-size limits, not a Foreman wall-clock deadline. No detached timer or duplicate Slack transport is introduced.

`agent/lib/slack-stop.ts` resolves the exact session and directly calls native `session.reset({ reason: "Slack stop requested." })` to retire it, including its background work. Reset is sent directly because a preceding cancel can wake the root through native child-result delivery. Session resolution and reset use framework-owned APIs without an authored abort option. The acknowledgement uses native `ctx.slack.request` and its existing SDK request behavior, also without an authored deadline parameter. Only a `reset` result permits "Stop requested.", deduplicated by `previousSessionId`; a missing session or `no_active_session` stays quiet. Parked sessions are also retired. Live UAT must verify that the old root cannot resume and that the next Slack message creates a fresh session. This is not a Foreman wall-clock deadline or a promise of immediate sandbox process termination.

### Sandbox file I/O

Foreman authors four file-I/O calls: `readTextFile` on the repository marker in `agent/lib/repository.ts` and `agent/tools/prepare_repository.ts`, `writeTextFile` on the same marker in `agent/tools/prepare_repository.ts`, and `readFile` on a sandbox image path in `agent/subagents/vision/tools/read_image.ts`.

The original Eve 0.44.0 audit found that the production Vercel backend dropped the abort signal on both reads and writes. In the installed Eve 0.54.2 adapter, `readFile` still calls the SDK as `readFile({ path })`; stream acquisition and the marker reads therefore remain without an authored cancellation surface. `writeFile` now forwards its signal to path resolution and `writeFiles`, so the marker write can be cancelled with its turn. Foreman still adds no independent wall-clock deadline to that small write. These paths are in `dist/src/execution/sandbox/abort-bound-session.js` and `dist/src/execution/sandbox/bindings/vercel.js`.

The marker read/write call sites handle a JSON document of a few hundred bytes on a path Foreman controls. Their wall-clock ceiling remains the Vercel function invocation limit; the write additionally honors native turn cancellation. Revisit the read exemption when Eve forwards that signal, or if a marker operation is observed to hang. Do not race a timer against a read that would continue after the reported failure.

The image read is split in two, because it is the one that reads an arbitrary path for an arbitrary number of bytes.

Draining the stream is bounded. `read_image` reads it through its own reader under one 20-second deadline covering the whole read, and starts cancelling the reader in `finally` without waiting on it, so neither a stalled transfer nor a cancellation that never settles can hold the turn open. Cancelling the reader is the layer that can actually stop the transfer; the signal eve would pass is not.

Acquiring the stream is exempt for the same reason the marker calls are. The `readFile` call that returns it takes the same dropped signal, and nothing Foreman owns exists yet to cancel, so its only bound is the Vercel function's own invocation ceiling. Racing a timer against it would report a failure while the request kept running. Revisit with the adapter.

### Agent browser install

`installAgentBrowser` in `agent/sandbox.ts` bootstrap is third-party (`@agent-browser/eve`) and runs during eve's own sandbox bootstrap, not inside a turn. It exposes no deadline parameter, and a bootstrap that never finishes fails template creation rather than holding a Slack thread open.

### Linked Linear follow-up reads

`agent/lib/support/triage-completion.ts` reads the journaled customer report, its one investigation document and bounded comment history before final completion, through the same support reads. It adds no writes or transport.

`agent/lib/support/linear-followup.ts` uses the existing support provider dispatch and its 50-second Executor deadline per call, including each issue read and comment page. Each case has at most ten tracked issues; each discussion scan stops at ten pages or one MB. The support lease is checked before each provider dispatch. No additional credentials or direct Linear transport are introduced.

`agent/lib/private-postgres.ts` constructs the shared Neon client with a fresh 15-second default deadline. Memory supplies its existing operation timeout and shares that client within an operation; support requests a fresh client per query. The shared module owns transport only, never store authorization or schemas.

## Fin identity verification

`agent/lib/fin-context.ts` bounds native Intercom conversation/contact reads and the Acquisity context request with a composed 50-second abort signal. App responses reject redirects and are bounded to 4 KiB while streaming, including cancellation during body consumption. The fixed reads in `agent/lib/executor/dispatch.ts` reuse the existing Executor transport and shared toolkit. Vercel Connect `getToken` exposes no cancellation option; credential resolution retains the existing Connect exemption, with the signal checked before and after resolution. No customer token or provider error is logged. This route starts no model, callback or Slack delivery.

## Fin customer investigation delivery

`readFinEvidence` in `agent/lib/executor/dispatch.ts` uses the existing shared Executor transport with a 50-second deadline, caller cancellation and a 128 KiB response cap. It accepts only fixed outreach read purposes and validated local UUIDs, constructs its own SQL, and checks active owner/admin membership in the same statement as the evidence. Credentials retain the existing Vercel Connect exemption. No raw provider response or failure body is returned to the model.

`agent/lib/fin-investigation-callback.ts` posts only a generic ready signal to an allowlisted Intercom Procedure callback URL. The signal contains no findings or run reference; the receiving Procedure must authenticate a result lookup with its own saved reference and native conversation. The request rejects redirects and has a five-second deadline. `agent/lib/fin-investigation-slack.ts` posts and updates one receipt in the configured internal channel with a five-second HTTP deadline; Slack token resolution retains the Vercel Connect exemption above. These delivery calls carry no customer token, workspace identifier, provider result or tool output.

## Fin run ownership additions (ENG-13766)

| Call | Bound | Reason |
| --- | --- | --- |
| `fin-run-store.ts` operational run reads/writes | 15 seconds per private Postgres operation via `privateDatabase` | Atomic start ownership and immutable saved result; failure must not dispatch replacement work. |
| `fin-delivery.ts` native conversation/contact reads | Shared 50-second AbortSignal plus existing Executor transport bounds | Recheck original destination and public human replies; failure suppresses customer delivery. |
| Result recovery event stream | Eight-second observation bound | Reads the exact existing session only; cancellation closes the reader, never the investigation. |
`receiveFinInvestigation` runs late identity and delivery checks concurrently with a shared five-second abort signal and response race. The race also bounds response waiting if credential resolution ignores cancellation; it never authorizes disclosure on timeout. Initial checks retain their existing deadlines.

Widget progress writes use the same private-DB transport with a 1.5-second deadline. Progress storage failure never blocks the investigation result.

## Local widget live harness (ENG-15026)

| Call | Bound or exemption | Reason |
| --- | --- | --- |
| `widget-live-policy.ts` loopback live-mode probe | Five-second AbortSignal, redirects refused | Carries the service secret only; no recorded scope or customer message precedes admission. |
| `scripts/widget-live.ts` loopback investigation and polling | Ten-minute request AbortSignal and ten-minute polling observation deadline, redirects refused | Calls only an admitted local server; investigation runs persist to local files. |
| `scripts/widget-live.ts` authored drift reads | Two-minute caller AbortSignal plus each provider's existing deadline | Exact-input reads reuse the authored widget tools and Executor transport. App token resolution uses the existing Vercel Connect exemption, which exposes no abort option. |
| `scripts/widget-live.ts` production run lookup | Thirty-second private Postgres client | SELECT-only reader; separate from the live server's file store. |
| `scripts/widget-run-stream.ts` Workflow CLI stream inspection | Three-minute child-process timeout | Shared existing CLI reader; stream decryption may hang. |
| `widget-live-store.ts` local filesystem operations | Local filesystem exemption; lock acquisition bounded to five seconds | Runs only without VERCEL_ENV and stores atomic JSON snapshots under `.eve/widget-live/`. No remote storage adapter or database URL is used. Node directory/rename APIs offer no cancellable operation; a crashed lock fails closed and requires local recovery. |
