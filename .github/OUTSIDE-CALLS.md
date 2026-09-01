# Foreman-authored outside calls

Every call Foreman itself writes that leaves the process, and the deadline it runs under. Recorded by ENG-13318 (northstar P8.4), which closed the gaps P8.1 to P8.3 left.

Eve framework-owned traffic (model provider requests, MCP connection traffic, channel delivery, workflow and queue steps) is deliberately absent: eve owns those deadlines, and P8 does not reach into them.

A new outside call belongs in this table. Two tests fail if one is added without a bound.

`agent/lib/outside-call-bounds.test.ts` sweeps every authored non-test TypeScript file under `agent/` through the inspector in `agent/lib/outside-call-bounds.ts`. The inspection is per call site, not per file: each call is located by its own parentheses and each option is read from that call's own argument list, so a bound removed from one call fails the sweep even when a neighbouring call still has one, and an unrelated call in the same file cannot stand in for a missing bound. Four classes are enforced. A `.run(` written anywhere under `agent/` outside `agent/lib/sandbox-deadline.ts` fails, whatever the receiver is called, because `boundedRun` is the only way Foreman runs a sandbox command. A `fetch` or `fetchImpl` call whose init object carries no `signal` fails. A call to an operation imported from `@vercel/blob` with no `abortSignal` in any argument fails. A `neon` client built without a `fetchOptions` signal fails. The same test carries a mutation case per class, each one a real call site with a single bound taken away, so the guard is checked to fail rather than assumed to.

`agent/lib/sandbox-deadline.test.ts` covers the shared sandbox helper, including the races between a caller's own cancellation and the deadline.

## HTTP requests

| Call | Bound | Notes |
| --- | --- | --- |
| `agent/lib/billing-api.ts` (Stripe, Autumn) | 20s per request | ENG-13315. Composed with the caller's signal; the failure is classified from the composed signal's first abort reason, so a late caller abort cannot turn a timeout into a cancellation. |
| `agent/lib/instantly-api.ts` | 15s per request | ENG-13316. The deadline stays armed through the body read and response disposal, so a stalled stream is bounded too. |
| `agent/lib/linear-api.ts` | 15s per request | Composed with the caller's signal. |
| `agent/lib/inngest-api.ts` | 15s per request | Composed with the caller's signal; a caller abort rethrows unwrapped. |
| `agent/lib/help-center.ts` | 10s per request | Composed with the caller's signal. A failure returns `error` rather than throwing, because search is advisory. |
| `agent/lib/planetscale.ts` | 50s per request, three requests per read | Matched to the PlanetScale MCP server's own 50s query deadline, so the bound never fires before the upstream's does. |
| `agent/subagents/vision/tools/read_image.ts` | 20s | Covers the body read; the signal is passed to `fetch`, so a stalled download aborts with it. The same 20s per-chunk reader deadline bounds the sandbox path branch, which no signal reaches (see the sandbox file I/O note below). |

## Other clients

| Call | Bound | Notes |
| --- | --- | --- |
| `agent/lib/investigation-memory/store.ts` | 15s per operation | ENG-13318. The Neon serverless driver sends each query as its own HTTP request and enforces no deadline. The client is built per operation, not cached: a cached one would hold an already-fired signal and refuse every later query. Several queries inside one exported function share the bound. |
| `agent/lib/blob.ts` | 20s per operation | ENG-13318. `@vercel/blob` retries internally but sets no overall deadline. |

## Sandbox commands

All of these run through `boundedRun` in `agent/lib/sandbox-deadline.ts`, which returns exit code 124 rather than throwing, so each caller's existing non-zero branch handles a deadline. A cancelled turn still throws, which is what keeps cancellation distinguishable from a timeout.

A caller that passes its own `abortSignal` keeps it: the helper composes the caller's signal with the deadline rather than replacing it, so an already-aborted caller signal still cancels the command. The failure is classified from the composed signal's reason, which latches whichever signal aborted first, so a deadline that fires while a cancellation is already in flight cannot turn that cancellation into a reported timeout.

| Call | Bound | Notes |
| --- | --- | --- |
| `agent/tools/prepare_repository.ts` | 300s per command | ENG-13317 bounded the clone, refresh, install, publish, and discard. ENG-13318 bounded the five local probes it left: worktree detection, origin read, the occupied and warm-checkout probes, and the git identity write. A deadline on the occupied probe refuses instead of publishing over a path it could not read. |
| `agent/tools/checkout_branch.ts`, `agent/tools/push_branch.ts` | 300s per command | ENG-13318. |
| `agent/subagents/implementer/tools/checkout_branch.ts`, `.../push_branch.ts` | 300s per command | ENG-13318. |
| `agent/subagents/reviewer/tools/checkout_branch.ts` | 300s per command | ENG-13318. |
| `agent/subagents/critic/tools/checkout_commit.ts` | 300s per command | ENG-13318. |
| `agent/sandbox.ts` `onSession` | 300s | ENG-13318. A deadline surfaces as the existing non-zero branch, which throws and fails the session rather than hanging it. |
| `agent/lib/repository-snapshot.ts` | 800s for the whole build | The sandbox itself carries `timeout: BUILD_TIMEOUT_MS`, so every command inside is bounded by the sandbox's own death, matched to eve's Vercel invocation ceiling. |

## Exemptions

Each of these is a call Foreman makes with no deadline, for a stated reason.

### Vercel Connect

`mintInstallationToken`, `getConnectorMetadata` in `agent/lib/github/bot-name.ts`, and the `userConnect` path in `agent/lib/user-connect.ts` all go through `@vercel/connect`.

`ConnectOptions` (`@vercel/connect@0.8.0`, `dist/token.d.ts:92`) carries only `vercelToken` and `forceRefresh`. There is no signal, no timeout, and no other cancellation surface, so there is nothing to bound. Racing a timer against the promise would report a failure while the request kept running, which is worse than waiting. Revisit when Connect exposes a signal.

### Sandbox file I/O

Foreman authors four file-I/O calls: `readTextFile` on the repository marker in `agent/lib/repository.ts` and `agent/tools/prepare_repository.ts`, `writeTextFile` on the same marker in `agent/tools/prepare_repository.ts`, and `readFile` on a sandbox image path in `agent/subagents/vision/tools/read_image.ts`.

The abort signal does not reach them. eve's `bindSandboxAbortSignal` does compose the turn's signal into every file call (`eve@0.44.0`, `dist/src/execution/sandbox/abort-bound-session.js`), and the session layer forwards it to the backend (`dist/src/execution/sandbox/session.js`), but the production Vercel backend drops it: `readFile` calls the SDK as `readFile({ path })` and `writeFile` calls `writeFiles([{ content, path }])`, neither passing a signal, and `removePath` is the only file operation that forwards one (`dist/src/execution/sandbox/bindings/vercel.js`). Foreman calls no `removePath`. `@vercel/sandbox@3.0.1` does accept `opts.signal` on these operations and sets no timeout of its own (`dist/api-client/base-client.js` passes only the caller's signal to `fetch`), so the capability exists and is simply never handed a signal. An earlier revision of this document claimed a cancelled turn unwinds these reads and writes. It does not, on the platform Foreman deploys to.

The two marker calls stay exempt, with the real bound stated rather than assumed: one read and one write of a JSON document of a few hundred bytes, on a path Foreman controls, whose only deadline is the Vercel function's own invocation ceiling. eve's abort plumbing does not shorten that. Bounding them would mean re-plumbing eve's sandbox adapter, which is out of scope here; revisit if the adapter starts forwarding the signal, or if a marker read is ever seen to hang.

The image read is bounded, because it is the one that reads an arbitrary path for an arbitrary number of bytes. `read_image` reads the stream through its own reader with a 20-second per-chunk deadline and cancels the reader in `finally`, so a stalled sandbox transfer is dropped rather than waited on. Cancelling the reader is the layer that can actually stop the transfer; the signal eve would pass is not.

### Agent browser install

`installAgentBrowser` in `agent/sandbox.ts` bootstrap is third-party (`@agent-browser/eve`) and runs during eve's own sandbox bootstrap, not inside a turn. It exposes no deadline parameter, and a bootstrap that never finishes fails template creation rather than holding a Slack thread open.
