# Eve proposals

Gating and composition requests checked against the versions named below, with what was built instead. Each entry names the eve version it was checked against, the supported subset that shipped, and the bounded change that would remove the workaround. ENG-13737 rechecked the relevant APIs at the previous eve upgrade, and ENG-15874 and ENG-15875 rechecked them against Eve 0.81.1; each section ends with its status on 0.81.1. Historical checks remain identified below; newly supported APIs do not justify unrelated gating changes. Nothing here is a reason to approximate a gate unsafely: where eve cannot express a bound, the authored subset ships and the remainder is written down.

## 1. Gate an extension as a whole, not one contribution at a time

Checked against eve 0.44.0.

An extension mount contributes tools, channels, connections, skills, schedules, subagents, instruction fragments, and hooks, and the mount itself cannot be resolved per session. Individual contributions can be: tools, skills, instruction fragments, and subagents each have a `defineDynamic` form that resolves per session, while channels, connections, schedules, and hooks have none. Reaching one of an extension's own contributions from the consumer is narrower still. It needs a consumer directory mount replacing the extension's own slot, and hooks and instruction fragments are additive, so they cannot be replaced at all. The replacement in that slot may be dynamic even where the extension's definition is static, because a same-named dynamic definition wins over a static one at runtime. What that does not buy is gating from anywhere else: a dynamic resolver in a separate file returning `null` leaves a same-named static definition in the catalog, which is the limitation section 2 records.

Shipped: `agent/extensions/github/tools/github.ts` replaces the extension's own `tools/github.ts` slot with a `defineDynamic` that returns the extension's own resolver behind `repositoryCapabilitiesAvailable`, and `null` otherwise. That is the whole GitHub surface today, because the extension contributes nothing else, so nothing is left ungated in practice. It would not be true of an extension that also contributed a skill or a schedule.

Proposal: let a mount take an availability resolver, for example `github(config, { available: (ctx) => boolean })`, resolved on `session.started` and `turn.started`, that omits every contribution the mount makes for that session. Same semantics as a dynamic subagent returning `null`, applied to a mount.

ENG-13737 update: dynamic connections are now supported alongside tools, skills, instructions and subagents. There is still no whole-mount availability resolver; channel, schedule and hook lifecycle is not made session-dynamic by a tool replacement. Keep the existing GitHub slot gate.

Eve 0.81.1 update (ENG-15874): still unresolved. No release through 0.81.1 adds a mount availability resolver; 0.69.0 (b34bab8) only moved extension configuration and state to each logical mount. Keep the GitHub slot gate.

Eve 0.83.2 update (ENG-16246): still open. No release from 0.82.0 through 0.83.2 changes this.

Status: Still open on 0.81.1.

## 2. Remove a same-named authored tool from a dynamic resolver

Checked against eve 0.44.0.

A dynamic tool whose name matches an authored one overrides it, but returning `null` does not remove the authored tool: the static definition stays in the catalog. So a static tool cannot be gated from a separate file; it has to become dynamic itself.

Shipped: each gated repository tool exports its `defineTool` object as a named export and a `defineDynamic` wrapper as its default, in the same file. The tool object is unchanged, so its callbacks keep the durable descriptors eve stamped on the `defineTool` call, and callers that need the definition directly import the named export.

Proposal: let a dynamic resolver returning `null` for a name suppress a same-named authored tool, or accept `disableTool()` as a resolver result.

ENG-13737 update: separate-file null suppression is still unavailable. Keep the same-slot authored wrappers and stamped callbacks; the supported built-in replacement described in section 5 does not suppress an unrelated static definition.

Eve 0.81.1 update (ENG-15874): still unresolved. 0.59.1 (1e872e3) added `tool: false` and a same-named `disableTool()`, but both hide a subagent's derived delegation tool, not a static authored tool from a separate resolver; see section 3. Keep the same-slot wrappers.

Eve 0.83.2 update (ENG-16246): still open. No release from 0.82.0 through 0.83.2 changes this.

Status: Still open on 0.81.1.

## 3. Gate a subagent's delegation tool without gating the subagent

Checked against eve 0.44.0.

`defineDynamic` in a subagent's `agent.ts` supports per-session availability. The factory-specific motivation is retired: Foreman now retains only critic and vision, both used by ordinary triage. No new child gate is needed for factory removal.

At ENG-13737 eve still prepared the delegation schema for each declared subagent; Foreman does not supply a narrower custom schema. Launches now return working receipts and results arrive later. Resolved by eve 0.69 tasks: a call returns a receipt and its result arrives in the same held turn. The report uses each compiled node's prepared tool. `pnpm report:capabilities` reads the installed schema rather than preserving the former eight-station count. A narrower framework schema remains a possible upstream improvement; it is not an upgrade prerequisite.

Eve 0.81.1 update (ENG-15874): resolved by 0.59.1 (1e872e3). `tool: false` on a subagent, or a same-named `disableTool()`, hides its delegation tool while workflow tools can still reach it through `ctx.agent()`; `defineDynamic` still covers per-session availability. Foreman needs neither for critic or vision. Measured on 0.81.1, the prepared delegation description equals the authored description: eve no longer appends background-task text (0.69.0, efa0869).

Status: Resolved in 0.59.1.

## 4. Gate a static extension tool per session without one slot per tool

Checked against eve 0.44.0. Recorded by ENG-13325 after the capability budget was remeasured.

The browser extension contributes 21 static tools, 11,828 catalog characters, to every lane, and after the repository-lane gate they are the largest catalog ordinary Slack still carries. eve's per-slot override is the only gate: each of the 21 would need its own `agent/extensions/browser/tools/<name>.ts` carrying a `defineDynamic` that returns the extension's tool object behind an availability check, and the extension's instructions fragment, being additive, would stay in every lane regardless. That is section 1 again, at 21 files instead of one, and it is not attempted. Ordinary Slack is also the lane that uses the browser, for attended investigation and demo recording, so there is no lane today that could shed it without losing capability; this is a framework cost, not a gating omission.

Proposal: the mount-level availability resolver of section 1, which would gate all 21 tools and the instructions fragment together.

Eve 0.81.1 update (ENG-15874): no longer applies to Foreman. The eve 0.81.1 upgrade removed the browser extension, so `agent/extensions/` mounts only GitHub and no lane carries these 21 tools. The framework limit itself is section 1 and remains unresolved.

Eve 0.83.2 update (ENG-16246): still open. No release from 0.82.0 through 0.83.2 changes this.

Status: Still open on 0.81.1 as section 1; no longer applies to Foreman.

## 5. Gate eve's built-in tools per session (supported)

The original Eve 0.44.0 check found only global `disableTool()` overrides. Since 0.45.0 (b3cf8ee), eve gives framework defaults the same file slots as authored tools, so a same-slot `defineDynamic` can return the imported default or `null` for that session. The requested mechanism is now available; no replacement gating system is needed.

Foreman keeps its current choices: native `agent` enabled and `ask_question` not added on root, critic and vision. No extra per-session built-in gate is introduced by this upgrade. Framework defaults now appear in the compiled manifest; the capability report excludes them by their compiled owner bindings, while measuring Foreman's authored and extension contributions. Dynamic MCP connections are also now public; the support dispatcher below remains for its existing policy and journal requirements.

Eve 0.81.1 update (ENG-15874): still resolved. The same-slot mechanism is unchanged. `ask_question` stopped being a default tool and `todo` was removed in 0.65.0 (60998d6); built-in tools moved into the reserved `eve` namespace (`eve__task_wait`, `eve__task_cancel`) in 0.76.0; and since 0.78.0 (db71190) a resolver no longer adds the catalog tools `eve__search`, `eve__tool`, and `eve__skill` on its own. The capability report still excludes every framework-owned tool by its compiled owner binding.

Status: Resolved in 0.45.0.

## 6. Time one tool call

Checked against eve 0.44.0. Recorded by ENG-13396 with the `action.result` ops line.

A tool-call duration is not expressible from a hook. `ActionResultStreamEvent.data` carries only `error`, `result`, `sequence`, `stepIndex`, `status`, and `turnId`, and `ActionsRequestedStreamEvent.data` carries only `actions`, `sequence`, `stepIndex`, and `turnId`. The result itself, `RuntimeToolResultActionResult`, carries only `callId`, `isError`, `kind`, `output`, and `toolName`. No timing field exists on either event's data, so a hook has nothing framework-supplied to read. eve does stamp every stream event with `meta.at`, the ISO-8601 emission time, but that lives on the envelope rather than in the data, and an elapsed time would mean subtracting one event's `meta.at` from another's.

Shipped: one bounded line per tool call with no duration, naming the tool, the connection, and `ok` or `error`. The hook keeps no state and starts no timer. Timing the call from a hook would mean carrying the `actions.requested` event's `meta.at`, keyed by call ID, and reading it back at `action.result`, which is hook-owned state that outlives the event that created it: it leaks whenever a call never returns, it is wrong under a resumed or replayed turn, and it invents a number eve never measured. That is exactly the unsafe approximation this file exists to avoid, so the line reports reach and failure and stays silent about latency.

ENG-13737 update: eve added workflow-tool action variants but still supplied no framework-measured tool duration on these result events. Keep the existing bounded outcome logs.

Eve 0.81.1 update (ENG-15874): resolved for instrumentation, not for hooks. 0.70.3 (3b1fe5c) gives `defineInstrumentation` providers a framework-measured `durationMs` on `tool.call.completed` and records `gen_ai.execute_tool.duration` on `execute_tool` spans. `ActionResultStreamEvent.data` still carries no timing field, so the `action.result` ops line stays duration-free; a duration belongs in an instrumentation provider if one is wanted.

Proposal: put a framework-measured elapsed time, or a start timestamp, on `ActionResultStreamEvent.data`. eve already owns both ends of the execution it is projecting, so the measurement is free there and unreachable anywhere else.

Eve 0.83.2 update (ENG-16246): still open. No release from 0.82.0 through 0.83.2 changes this.

Status: Resolved in 0.70.3 for instrumentation providers; still open on 0.81.1 for hooks.

## Per-session MCP connection URL selection (resolved in Foreman)

Checked against eve 0.44.0.

Ordinary Foreman workflows retain one shared Executor toolkit. ENG-13601 introduces an explicit scheduled-support exception. Eve 0.44 requires a static `McpClientConnectionDefinition.url`, so that job denies the general MCP connection and uses an authored operation dispatcher to the support toolkit. Its helpers select the same endpoint from the framework-owned initiator identity. This preserved existing interactive discovery and gave support Linear writes a durable journal.

Eve 0.47.4 (a0c33dc) added `defineDynamic` connections with explicit stable instance keys for authenticated definitions. The former static-URL restriction is historical. Foreman retains its support dispatcher because selected operations, delegated write denial and durable Linear journal recovery are still required; replacing it with a dynamic connection alone would not preserve those behaviors. Eve 0.81.1 still supports dynamic connections.

Status: Resolved in 0.47.4.


## Durable per-run cancellation for support schedules

Checked against Eve 0.44.0 for ENG-13601 and corrected for ENG-13724. A custom channel cannot fail a turn from its event handlers: `callAdapterEventHandler` in `node_modules/eve/dist/src/channel/adapter.js` catches every adapter handler error and logs it as "adapter event handler threw — event swallowed", so the run continues. Only an authored hook throw fails the turn, because `dispatchStreamEventHooks` in `node_modules/eve/dist/src/context/hook-lifecycle.js` awaits handlers with no catch. The channel's `SessionHandle` exposes identity and continuation rekeying, not cancellation or a durable timer, and the cross-channel send options do not accept per-run resource limits. Support therefore applies an eighteen-minute deadline and a ceiling of 150 model steps from a `step.started` hook, twenty-minute provider-write leases, and the existing provider/sandbox deadlines. This bounds work at the available boundaries; it is not a promise to interrupt one silent model call or the Connect SDK exactly at eighteen minutes. No detached timeout or polling workflow is used to simulate that guarantee.

ENG-13737 update: support runs use conversation sessions so background results can return. Normal parent-turn completion does not settle a claim. The public `defineState` counter enforces 150 total root steps across turns, preserving the original eighteen-minute deadline. Public input/authorization hooks prevent unattended root and child waits. Root turn failures use auth and terminal session failures use persisted channel claim state. An unfinished first intake gets the existing notice on a later claim after its twenty-minute lease expires; pending outboxes reconcile first. Dormant sessions use Eve's default thirty-day lifetime from creation. These changes do not create a durable wall-clock interruption for a silent provider call.

Eve 0.81.1 update: since 0.68.0 a hook that throws no longer fails the turn; eve logs the error and continues, so the thrown bound above enforced nothing after that release. Eve 0.68.0 also added `ctx.cancel()` for hooks, which resolves the cancellation need: the support hook now logs one bounded `support.run_bound` line and cancels the turn, which ends with `turn.cancelled`, and the support channel settles a root cancel the same way as a root failure. A custom channel still cannot fail a turn from its event handlers, but a hook can cancel one.

Proposal: expose a runtime-owned per-run deadline on channel sends that cancels model calls, delegated work and token resolution durably.

Eve 0.83.2 update (ENG-16246): still open. No release from 0.82.0 through 0.83.2 changes this.

Status: Resolved in 0.68.0 for cancelling a turn from a hook; the runtime-owned per-run deadline is still open on 0.81.1.

## Register receive-only channels

Checked against eve 0.44.0 after ENG-13601's first production intake tick. The compiler emits channel entries from HTTP routes, so `routes: []` omits a receive-only channel from the runtime catalog. Cross-channel dispatch also falls back to a route fingerprint when bundled module references differ. Foreman's support channel therefore carries one inert GET route that always returns 404, allowing registration without exposing session creation. A compiled-manifest regression test checks that the channel survives compilation.

ENG-13737 upgrade: retain the inert route and verify it in `channelRoutes.effective` of the compiled manifest. This upgrade does not remove the receive-only registration safeguard or expose an HTTP session-creation endpoint.

Proposal: compile receive-only channels independently of routes and resolve cross-channel targets by durable channel identity.

Eve 0.83.2 update (ENG-16246): still open. No release from 0.82.0 through 0.83.2 changes this.

Status: Still open on 0.81.1. The 0.81.1 compiled manifest still carries channels only through `channelRoutes`, and `agent/lib/support/channel-registration.test.ts` still checks the inert route.

## Author-controlled background task reporting

Superseded by eve 0.69 tasks: the reporting instruction, delivery policy and `<eve-empty-delivery/>` are gone, results arrive in the same held turn, and Foreman uses eve's `no_reply` tool for an empty scheduled report.

Before 0.69, eve appended its own "Background task reporting" instruction to root turns (`tasks/delivery-context.js`, chosen in `tasks/delivery-policy.js`). A turn that launches a task is told to end with a launch acknowledgement, and a turn started by settled tasks is told "Do not reply with `<eve-empty-delivery/>`. Send one user-facing response that combines their useful results." An agent cannot change or disable either instruction, and a channel handler cannot see `taskDeliveryPhase`, so it cannot tell a settled-task turn from a user turn.

Before 0.69, Foreman delayed the requester answer until the settled-task turn and used the empty-delivery marker to suppress late recaps after ENG-14042 exposed that failure.

Proposal: let the agent set the task delivery policy per session or per channel (allow empty delivery on settled turns, suppress the launch acknowledgement), and expose the delivery phase on `turn.started` to channel handlers.

Status: Resolved in 0.69.0.


## Skip an eval after replay coverage is known

Checked for ENG-14746 and rechecked on Eve 0.81.1. The public `t.skip(reason)` rejects calls after session activity or recorded assertions with "skip() must be called before creating sessions, sending messages, or recording assertions." Replay coverage is known only after the investigator runs, so a post-run skip cannot preserve the leak and raw-field gates.

Foreman keeps those safety gates and records one tracked-only `.soft()` assertion without a threshold, named "replay coverage", stating the unrecorded tools. Uncovered rows carry `scored: false` and `unrecordedReads`; behavior checks are computed but are not asserted or counted, the claims judge does not run, and loop measurements exclude those rows. Eve's verdict reflects safety checks, not a fully covered replay pass.

Proposal: support a public post-activity not-scored result that retains failed safety gates and excludes uncovered runs from grading totals.

Eve 0.83.2 update (ENG-16246): still open. No release from 0.82.0 through 0.83.2 changes this.

Status: Still open on 0.81.1.

## Warm snapshot image tracks eve's sandbox image

Checked against Eve 0.81.1 for ENG-15910. When the sandbox source is a snapshot, `vercel-create-sdk.js` passes no `image` to `Sandbox.create`, so the session runs on the image the snapshot was built from. eve 0.81 moved its Vercel image to `vcr.vercel.com/vercel/eve/base:<eve version>` (`EVE_SANDBOX_IMAGE_TAG` overrides the tag), and its initialization command runs in the default `/vercel/sandbox`. A snapshot built from the previous eve's older `vercel/eve` image lacks that directory, so every session failed with "chdir /vercel/sandbox: no such file or directory". `agent/lib/repository-snapshot.ts` now derives the image the way eve does, because eve's resolver is not exported. Every eve upgrade requires a snapshot rebuild.

Proposal: export the resolved sandbox image from a public entry, and reject or warn on a snapshot source built from a different image.

Eve 0.83.2 update (ENG-16246): still open. No release from 0.82.0 through 0.83.2 changes this.

Status: Still open on 0.81.1.
