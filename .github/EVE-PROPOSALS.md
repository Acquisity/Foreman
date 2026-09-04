# Eve proposals

Gating and composition Foreman wants but eve cannot express today, with what was built instead. Each entry names the eve version it was checked against, the supported subset that shipped, and the bounded change that would remove the workaround. Nothing here is a reason to approximate a gate unsafely: where eve cannot express a bound, the authored subset ships and the remainder is written down.

## 1. Gate an extension as a whole, not one contribution at a time

Checked against eve 0.44.0.

An extension mount contributes tools, channels, connections, skills, schedules, subagents, instruction fragments, and hooks, and the mount itself cannot be resolved per session. Individual contributions can be: tools, skills, instruction fragments, and subagents each have a `defineDynamic` form that resolves per session, while channels, connections, schedules, and hooks have none. Reaching one of an extension's own contributions from the consumer is narrower still. It needs a consumer directory mount replacing the extension's own slot, and hooks and instruction fragments are additive, so they cannot be replaced at all. The replacement in that slot may be dynamic even where the extension's definition is static, because a same-named dynamic definition wins over a static one at runtime. What that does not buy is gating from anywhere else: a dynamic resolver in a separate file returning `null` leaves a same-named static definition in the catalog, which is the limitation section 2 records.

Shipped: `agent/extensions/github/tools/github.ts` replaces the extension's own `tools/github.ts` slot with a `defineDynamic` that returns the extension's own resolver behind `repositoryCapabilitiesAvailable`, and `null` otherwise. That is the whole GitHub surface today, because the extension contributes nothing else, so nothing is left ungated in practice. It would not be true of an extension that also contributed a skill or a schedule.

Proposal: let a mount take an availability resolver, for example `github(config, { available: (ctx) => boolean })`, resolved on `session.started` and `turn.started`, that omits every contribution the mount makes for that session. Same semantics as a dynamic subagent returning `null`, applied to a mount.

## 2. Remove a same-named authored tool from a dynamic resolver

Checked against eve 0.44.0.

A dynamic tool whose name matches an authored one overrides it, but returning `null` does not remove the authored tool: the static definition stays in the catalog. So a static tool cannot be gated from a separate file; it has to become dynamic itself.

Shipped: each gated repository tool exports its `defineTool` object as a named export and a `defineDynamic` wrapper as its default, in the same file. The tool object is unchanged, so its callbacks keep the durable descriptors eve stamped on the `defineTool` call, and the subagent copies that need the tool unconditionally import the named export.

Proposal: let a dynamic resolver returning `null` for a name suppress a same-named authored tool, or accept `disableTool()` as a resolver result.

## 3. Gate a subagent's delegation tool without gating the subagent

Checked against eve 0.44.0.

`defineDynamic` in a subagent's `agent.ts` does support per-session availability, so this is expressible. It is recorded here only as the not-yet-done half of the same question: the eight subagents cost about 8,000 catalog characters in every lane, and the five factory stations are useless outside a factory lane. Doing it needs the child-session auth contract checked first, which is its own ticket.

The delegation input schema itself is not expressible. eve lowers one fixed schema onto every subagent tool, 579 characters each and 4,632 across the eight, read from `getSubagentToolInputJsonSchema` in eve's subagent registry. An authored subagent cannot shorten or replace it, so the only authored lever on that cost is gating the subagent.

Proposal: let a subagent declare a narrower delegation schema, or let eve drop the optional fields a persistent-session-less agent never uses.

## 4. Gate a static extension tool per session without one slot per tool

Checked against eve 0.44.0. Recorded by ENG-13325 after the capability budget was remeasured.

The browser extension contributes 21 static tools, 11,828 catalog characters, to every lane, and after the repository-lane gate they are the largest catalog ordinary Slack still carries. eve's per-slot override is the only gate: each of the 21 would need its own `agent/extensions/browser/tools/<name>.ts` carrying a `defineDynamic` that returns the extension's tool object behind an availability check, and the extension's instructions fragment, being additive, would stay in every lane regardless. That is section 1 again, at 21 files instead of one, and it is not attempted. Ordinary Slack is also the lane that uses the browser, for attended investigation and demo recording, so there is no lane today that could shed it without losing capability; this is a framework cost, not a gating omission.

Proposal: the mount-level availability resolver of section 1, which would gate all 21 tools and the instructions fragment together.

## 5. Gate eve's built-in tools per session

Checked against eve 0.44.0.

eve's default tools (`bash`, `read_file`, `web_fetch`, and the rest) are gated only globally: a `disableTool()` sentinel in `agent/tools/<slug>.ts` removes one for every session, which is how `agent` and `ask_question` are removed today. There is no per-session form, and the built-in catalog is outside the compiled manifest, so `pnpm report:capabilities` does not measure it. Every lane carries the same built-in set by construction.

Proposal: accept a `defineDynamic` in a built-in tool's slot that returns the default or `null` per session, matching what authored and extension slots already allow.

## 6. Time one tool call

Checked against eve 0.44.0. Recorded by ENG-13396 with the `action.result` ops line.

A tool-call duration is not expressible from a hook. `ActionResultStreamEvent.data` carries only `error`, `result`, `sequence`, `stepIndex`, `status`, and `turnId`, and `ActionsRequestedStreamEvent.data` carries only `actions`, `sequence`, `stepIndex`, and `turnId`. The result itself, `RuntimeToolResultActionResult`, carries only `callId`, `isError`, `kind`, `output`, and `toolName`. No timing field exists on either event's data, so a hook has nothing framework-supplied to read. eve does stamp every stream event with `meta.at`, the ISO-8601 emission time, but that lives on the envelope rather than in the data, and an elapsed time would mean subtracting one event's `meta.at` from another's.

Shipped: one bounded line per tool call with no duration, naming the tool, the connection, and `ok` or `error`. The hook keeps no state and starts no timer. Timing the call from a hook would mean carrying the `actions.requested` event's `meta.at`, keyed by call ID, and reading it back at `action.result`, which is hook-owned state that outlives the event that created it: it leaks whenever a call never returns, it is wrong under a resumed or replayed turn, and it invents a number eve never measured. That is exactly the unsafe approximation this file exists to avoid, so the line reports reach and failure and stays silent about latency.

Proposal: put a framework-measured elapsed time, or a start timestamp, on `ActionResultStreamEvent.data`. eve already owns both ends of the execution it is projecting, so the measurement is free there and unreachable anywhere else.

## 7. Tell a stop from any other cancellation in a channel handler

Checked against eve 0.44.0. Recorded by ENG-13453 with the Slack cancellation notice.

The Slack `turn.cancelled` handler posts the one short notice at the moment eve's cooperative cancellation ends the turn, and it cannot say what cancelled it. `TurnCancelledStreamEvent.data` carries only `sequence` and `turnId`; `SlackSessionOperations.cancel` and `Session.cancel` accept only `{ turnId }`, with no reason to carry through; and `SlackInboundMessageContext`, where dispatch consumes a literal `stop`, has no `state`, because eve hydrates `SlackChannelState` only for `events[type]` handlers. So dispatch has nowhere to record that a stop was requested, and the handler has nothing to read: a session reset, a declined or timed-out session limit, and a `stop` all arrive as the same event.

Shipped: the notice is worded for every source, `Cancelled. This request did not finish.`, so it never claims a stop that did not happen. Keeping a stop flag outside eve would mean a store keyed by turn id that dispatch writes and a handler reads later, which leaks when the cancel never lands and is wrong under a replayed turn: hook-owned state outliving its event, the same shape section 6 refuses.

Proposal: carry an optional `reason` on the cancel command through to `turn.cancelled` data, or hydrate channel state for the inbound message context so dispatch can leave a marker the settling handler reads.
