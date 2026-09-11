# ENG-13686 investigation reliability audit

## Implemented fixes

A literal Slack stop used to read the session stream from event zero through its tail before submitting cancellation. The confirmation timeout started after that replay. This made cancellation admission grow with investigation history even when the latest event already identified the active turn.

The stop handler now reads the snapshotted tail first. A parent event supplies the exact turn ID; a terminal event stays quiet. If the tail contains forwarded child activity, it searches earlier windows for the parent turn or a terminal boundary, never treating a nested child turn ID as the parent. Confirmation still starts after the original tail and requires the matching `turn.cancelled`, so a natural completion or another turn's cancellation cannot generate a false confirmation. Histories consisting of forwarded child events can still require multiple windows; this is not a universal constant-time guarantee.

The regression tests use a 100,000-event root history and require only the latest event plus the cancellation confirmation to be consumed. They also cover idle/terminal sessions, child forwarding, and completion/cancellation races. The existing typing-status cleanup remains part of PR 127.

The billing skill and its reference catalog contradicted the root's unavailable-source rule: they prescribed another Executor read after a helper failure, even on authorization failure. They now record the gap and continue. Provider reads outside a successful helper's coverage remain available, and the existing wrong-customer-ID correction remains distinct from source unavailability. Named local binding failures remain eligible for one discovered read because no provider request occurred; this preserves recovery from the earlier malformed preview bindings. No toolkit permissions or provider routes changed.

## Measured history replay

Read-only benchmark of the recorded 23m47s production session `wrun_41M2867DHW0GKYEWD8WE8XCFMM`:

| Read | Events | Bytes | First measurement | Second measurement |
| --- | ---: | ---: | ---: | ---: |
| From start through waiting | 5,430 | 13,632,133 | 19.480s | 3.456s |
| Last event | 1 | 195 | 0.237s | 0.210s |

These are external Eve HTTP-stream measurements, not timings inside the Slack dispatcher. They demonstrate replay cost and variability, not a guaranteed production stop duration. The code audit and regression test establish that the old dispatcher required the full replay and the new root-turn path does not. This does not establish the cause of the investigation's 23-minute duration.

## Isolated instruction experiments

All fixtures were synthetic. No candidate completion or decoding paragraph was added to Foreman. Both arms used `deepseek/deepseek-v4.1-flash`; providers were restricted equally within each experiment. Successful inference must be separated from capacity, timeout, and output-generation failures.

| Experiment | Baseline correct / incorrect / unavailable | Candidate correct / incorrect / unavailable |
| --- | --- | --- |
| Fireworks decision pilot, interrupted, 1600 output-token cap | 3 / 0 / 2 | 4 / 0 / 2 |
| DeepInfra decisions, two repetitions, 8192 output-token cap | 2 / 1 / 3 | 3 / 2 / 1 |
| Fireworks decoding pilot, interrupted | 5 / 0 / 1 | 5 / 0 / 2 |
| DeepInfra decoding, three repetitions | 10 / 0 / 2 | 11 / 0 / 1 |

The decision failures included choosing a structured action inconsistent with the explanation. The longer candidate wording did not establish better decisions or faster completion. The successful decoding responses were correct in both arms, so this small fixture did not reproduce the navigation failures from the real investigation. Some experiments overlapped, and provider capacity errors further prevent a latency comparison. The initial connection smoke and a three-request aborted setup pass are excluded from this table; neither was a completed comparison.

The real [Executor contract check](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1789136423084439) on e01e861 completed in about 82 seconds with six tool results. Its event stream confirms one permitted Linear read and no Autumn query. Both described operations return Executor success/error unions; Linear's successful `data` contains MCP text with JSON, consistent with the described MCP envelope. The bot's final assertion that this was a schema mismatch was not supported by the actual described schema. That assertion is not evidence of an Executor contract defect.

Strict provider filtering exposed capacity errors on both Fireworks and DeepInfra. The live preview preference continues to permit Gateway fallback. These restricted-call failures do not establish that an equivalent production request with automatic routing would fail.

## Exact provider contribution in the production baseline

The durable `step.completed` events contain `providerMetadata.gateway.generationId`. Joining these IDs to Gateway's generation lookup matched all 65 completed root generations in the production baseline. This replaces the earlier timestamp-only correlation for those requests. The canceled in-flight generation and any work not represented by a completed root event remain outside this total.

| Serving provider | Completed requests | Generation time | Reported time to first token |
| --- | ---: | ---: | ---: |
| DeepInfra | 29 | 804.028s | 565.563s |
| Fireworks | 28 | 212.399s | 103.186s |
| Baseten | 5 | 17.374s | 9.084s |
| Wafer | 3 | 23.955s | 21.821s |
| Total | 65 | 1,057.756s | 699.654s |

Completed model requests account for 17m37.756s, approximately 74% of the 23m47.31s run. Reported first-token waits alone sum to 11m39.654s. These are exact request joins, not an assertion that all other time was useful or that the same prompts would be faster on a different provider. They establish provider-request latency as a major contributor in this baseline. The slowest joined request took 81.563s, including 62.482s to first token, and returned 210 completion tokens. Sanitized per-request evidence is in `evals/investigation/results/2026-09-11-production-generations.csv`.

The current live preview's first 50 completed requests show the same pattern: five DeepInfra-served requests accumulated 315.869s, including 253.260s to first token. This is a partial run, not a completed comparison.

[Gateway generation lookup](https://vercel.com/docs/ai-gateway/observability-and-spend/usage) defines the metrics. [Provider timeouts](https://vercel.com/docs/ai-gateway/models-and-providers/provider-timeouts) currently apply only to BYOK, while these matched requests report `isByok: false`, so that knob would not address them. [TTFT sorting](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering) is a candidate routing experiment that retains fallback availability; it is not yet a production recommendation.

## Remaining release evidence

A representative read-only two-ticket investigation started at 14:24:50 UTC on e01e861 in [this preview thread](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1789136666018449). It finished naturally at 14:41:43 UTC, about 16m53s after the turn started. The scheduled 20-minute stop was withdrawn. This is not a cancellation pass. A fresh investigation with automatic Gateway routing will be stopped after 15m30s if still active; that tests the reported over-15-minute range without claiming a 20-minute cancellation result.

Production is unchanged. PR 127 remains draft. The local decision replays do not replace direct/factory preview validation or prove overall production reliability.

## Local routing and additional route pilots

`pnpm dev` direct and factory-selection smoke checks completed after an initial sandbox-prewarm timeout on the direct check. That failed local run was canceled; a retry answered without tools, and the factory check loaded the factory-pipeline skill and reported the station order without dispatching stations or writing services. This exercises routing, not a full factory pipeline.

Small matched routing pilots compared the existing Fireworks preference with the same preference plus Gateway `sort: ttft`. Four pairs of plain-text generations had median total times 1.799s current / 3.184s sorted; tool-call generations were 5.366s / 1.656s; streaming tool-call generations were 2.796s / 8.576s. These synthetic probes did not establish a consistent benefit. Some probes overlapped other test work. No TTFT sorting option or unsupported BYOK timeout has been enabled in Foreman. The preview Fireworks preference was removed for the next production-like test; production settings remain unchanged.
