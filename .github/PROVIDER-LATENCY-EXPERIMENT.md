# ENG-13686 provider comparison

This draft experiment changes only the root model's serving preference on Vercel Preview. Set the branch-specific `FOREMAN_PREVIEW_PROVIDER` to a verified Gateway provider slug, such as `fireworks`. Unset it for automatic routing. Deploy after changing it and use fresh threads. It is ignored outside Preview. Gateway `order` retains fallback; count the actual serving provider from request metadata, not the requested preference.

The root keeps its existing model wrapper, model ID resolver, tools, instructions, reasoning defaults, and access. Children keep their existing model selections and automatic routes. Saved model overrides are shared by production and preview and must not be edited for this experiment. The root resolves at each step; children resolve at session start. Record any effective-model drift during a run.

## Setup verified September 11, 2026

- Current main and production SHA: `a5ec81e204bdfed034b527660661ad9eec2ae811`; production deployment: `dpl_8JQ4NXxkJ886PmFcs8HPRkSx17Jz`.
- Saved root, analyst, classifier, implementer, investigator, researcher and reviewer model: `deepseek/deepseek-v4.1-flash`. Critic: `anthropic/claude-fable-5.1`. Vision has no saved override and resolves to `google/gemini-3.5-flash`.
- Production and preview use the same model-settings Blob store. The existing Executor connector is attached to both environments, but its environment bindings were scoped to the older Executor preview branch. This branch needs the same three production Executor binding values. Existing shared database and Gateway credentials stay in Vercel.
- Verified Slack bot identities: production `U0BQ5QMHM7D`; preview `U0BTGKF57T7`. Preview channel: `C0BUF4GU8C8`. Production baseline DM: `D0BQ8BU2945`, with Aaron and production Foreman.
- Gateway's current endpoint catalog lists Fireworks and DeepInfra for the exact Flash model, among other providers. Availability and aggregate metrics do not establish this experiment's result.

## First paired case

ENG-13651 is currently Todo. Claim: selecting 1,000 credits leaves billing loading instead of opening checkout. A useful answer independently verifies the code mechanism, separates it from the customer's unverified incident trigger, identifies missing evidence, and states the supported handling.

Production prompt sent at `2026-09-11T12:06:53.251Z`, [DM thread](https://acquisityworkspace.slack.com/archives/D0BQ8BU2945/p1789128413251539):

> Investigate https://linear.app/acquisity/issue/ENG-13651/billing-page-not-working concerning the reported endless loading after selecting 1,000 credits. Repository: https://github.com/Acquisity/Acquisity. Independently verify the relevant code and available incident evidence, using the existing investigation as a pointer rather than accepting its conclusion. This run is read-only: use the available evidence and tools, but do not modify tickets, documents, memory, customer records, or repositories, or send messages elsewhere. Reply here with what is proven, what remains unknown, and the exact actions you would normally take.

That first message was bot-authored and did not start a turn. The valid production baseline began at `2026-09-11T12:14:08.214Z` in [this DM thread](https://acquisityworkspace.slack.com/archives/D0BQ8BU2945/p1789128848214259). Message delivery alone does not prove a turn started.

After the baseline completes, send a fresh preview thread with the same claim and repository, replacing the read-only instruction with: "Complete the normal investigation and handling, including updating the existing Triage investigation document, applying evidence-backed ticket routing, and posting the investigation result on the ticket. Report your evidence-backed conclusion and the actions actually completed."

ENG-13658 is a candidate access/billing case, currently Canceled. Read its current evidence and cancellation reason before choosing its concrete action scope. Select a routine shorter case from current tickets. Do not reuse changed case state as an identical repetition or feed baseline conclusions into preview.

## Run ledger and comparison

For each run retain exact prompt, initial ticket/document state, Slack permalink, UTC times, SHA, deployment, parent/child run IDs, effective model IDs, requested route, actual providers and fallback attempts. Capture request IDs, duration, displayed TTFT, usage/cache, cost, errors, model decisions, failed calls, repeated reads, supported conclusion, and action read-backs.

Compare equivalent investigation stages. Report total elapsed and additional action work separately. Keep failed runs in the results. A terminal critic session does not prove review success. If cancellation is needed, verify the actual turn and children are terminal.

## References

- [Execution handoff](https://linear.app/acquisity/document/eng-13686-execution-handoff-provider-comparison-on-foreman-preview-2c67c090814a)
- [All five original audit files](https://linear.app/acquisity/document/eng-13686-source-evidence-five-original-latency-reports-and-csvs-0231675d70fa)
- [Gateway provider ordering](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering)

No routing recommendation is established yet. The historical 72 requests totaling 62m 44.66s were timestamp/context correlations, not exact generation-to-step joins. Instruction changes, critic behavior, and investigation stopping policy remain outside the provider comparison. The cancellation display defect observed during the baseline is addressed separately below.

## Observed cancellation defect

The ENG-13651 production baseline reached 23m 47.31s without a final answer and had at least 98 completed root tool calls at inspection. It kept expanding evidence collection, including repeated code reads and tool-output parsing retries. Its two vision tasks finished early. The dashboard cancellation action reported failure; an authenticated Eve cancellation request scoped to `turn_0` was accepted, and `turn.cancelled` was logged at `2026-09-11T12:37:58Z`.

The actual turn workflow, `wrun_41M2867FP90GRD5120FMEKZ7XR`, and all 72 of its steps were terminal when checked after cancellation. The last model step completed at `12:37:56.551Z`, followed by descendant cancellation and turn-control completion. No later tool results were observed for the parent session `wrun_41M2867DHW0GKYEWD8WE8XCFMM`. This is an incomplete baseline, not a successful investigation or proof that every historical cancellation problem has the same cause.

Slack still displayed the last reasoning status. Foreman's `turn.cancelled` handler cleared progress state but never cleared the provider typing indicator. API cancellation also bypasses the explicit Slack stop-command confirmation. The fix calls Eve's documented `thread.startTyping()` without an argument to clear the status and resets buffered typing state. It preserves the existing stop-command confirmation behavior. The original DM's status was cleared operationally with `assistant.threads.setStatus`, which returned `ok: true`. Production code has not been changed.

## Preview setup failure and correction

The first billing preview investigation failed because a local environment-file parser truncated `EXECUTOR_OPERATION_BINDINGS` to an opening brace. Executor discovery and Linear reads worked, but authored provider helpers failed locally with `invalid_operation_bindings`. The run was canceled and excluded from valid route comparisons. Configuration was corrected using Vercel's environment-value API, and all 36 mappings matched the repository and passed the runtime binding validator. Do not parse a pulled environment file to copy structured JSON values.

Deployment `dpl_ERozBETKkSGvrXfsqEv7cWBU71dN` at `4d4c223` passed a fresh [three-helper smoke test](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1789129941105949): Autumn, Stripe, and billing-account reads all succeeded. The corrected billing comparison runs on that immutable deployment, before the cancellation-display fix; keep its measurements attached to that SHA.
