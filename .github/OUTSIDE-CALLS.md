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
| `scripts/executor-readiness.ts --live` | 20s per GET | Operator-only toolkit, policy, and connection-pattern metadata from the fixed Acquisity Executor API; redirects refused. Uses the selected local OAuth profile without requesting provider credentials or printing tokens. |
| `agent/lib/executor/transport.ts` | 50s for handshake and invocation, composed with the caller and provider deadline | Covers body streaming; 8 MiB cap; redirects refused. Provider helpers below impose their tighter existing deadlines. |
| `agent/lib/billing-api.ts` (Stripe, Autumn) | 20s per request | ENG-13315. Composed with the caller's signal; the failure is classified from the composed signal's first abort reason, so a late caller abort cannot turn a timeout into a cancellation. |
| `agent/lib/instantly-api.ts` | 15s per request | ENG-13316. The deadline covers the complete typed call, including MCP response streaming in Executor transport; provider retries begin only after the prior invocation has settled. |
| `agent/lib/linear-api.ts` | 15s per request | Composed with the caller's signal. |
| `agent/lib/inngest-api.ts` | 15s per request | Composed with the caller's signal; a caller abort rethrows unwrapped. |
| `agent/lib/help-center.ts` | 10s per request | Composed with the caller's signal. A failure returns `error` rather than throwing, because search is advisory. |
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

### Native Slack history, cancellation and acknowledgement

`agent/lib/slack-history.ts` calls the public `loadThreadContextMessages` helper only for a reply in a Slack thread that has no existing Eve session. It reuses Eve's thread refresh, which reads at most the first 50 replies, and caps the added context at 32,000 characters. The public helper and native Slack request surface expose no authored abort signal; token resolution uses the Connect exemption above. These are result-size limits, not a Foreman wall-clock deadline. No detached timer or duplicate Slack transport is introduced.

`agent/lib/slack-stop.ts` resolves the exact session, reads a fixed snapshot of at most 256 already-observed stream events, cancels the reader, and calls native `session.cancel({ turnId, tasks: true })`. It does not follow the stream while waiting for confirmation. The session operations are framework-owned APIs without an authored abort option. The acknowledgement uses native `ctx.slack.request` and its existing SDK request behavior, also without an authored deadline parameter. "Stop requested." reports accepted cancellation only; child settlement is verified separately. Do not describe the event-count cap or removal of the former confirmation wait as a hard cancellation deadline.

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
