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
