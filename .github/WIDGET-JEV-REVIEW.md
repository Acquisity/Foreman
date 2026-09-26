# Widget JEV review experiment

The widget's logged `judge` time is the model review inside the egress gate. It is separate from deterministic ownership checks and reply composition.

## Wiring

Set `WIDGET_REVIEWER=jev` in an isolated Preview to select JEV for every widget investigation that reaches model review. It uses the existing `TYPESAFE_API_KEY`. Unset preserves the current gate model. Direct Help Center answers use a separate path.

One request asks three separate questions about each numbered claim and recommendation sentence. Code derives the verdict and uses the existing deletion-only rewrite. Ownership scans before review and after composition, human-review flags, and the composer are unchanged.

## Decision policy

| Question | Choices |
| --- | --- |
| `own_N`: whose data is it | owned, foreign, unsure |
| `item_N`: may the wording be shown | keep, remove |
| `need_N`: what deleting it would do | material, dispensable |

An answer counts only at 0.8 confidence or above. Per item, in order:

1. Ownership is not confidently owned or confidently foreign: block (`ownership_uncertain`). Nothing else can override this.
2. Confidently owned and confidently keep: shown unchanged.
3. Otherwise the item cannot be shown as is: it is confidently foreign, a confident violation, or the wording verdict is uncertain. It is deleted only when it is confidently dispensable. If not, JEV does not decide it (`violation_not_removable` or `uncertain_not_removable`; see the fallback below), so a caveat, an unresolved payment or delivery concern, or a handoff statement is never stripped to get an answer out.

Uncertain wording therefore no longer counts as an ownership failure, but it is never shown and never deleted on doubt alone. The threshold was not lowered. After the review, by either reviewer, findings with `needsHuman` set stop as `needs_human` with every finding intact and no reply is composed: Acquisity discards the reply for a handoff, posts the findings as a team-only note and shows its own handoff message.

Missing credentials, request failures, oversized input, a missing or extra answer, and a choice that does not belong to its question all fail closed.

Each review logs one `widget.review.items` line: the decision, the reason category in `code`, and for every item that was not a clean keep its number with the three choices and confidences (`14:owned.97/keep.62/dispensable.91`), deciding item first. It never contains item text or identifiers, and the ops log bounds its length.

## Fallback to the existing reviewer

Live replays of `1a2e044` showed the remaining false blocks share one cause: a single item JEV is unsure about blocks a whole useful answer. The materiality question in particular is noisy (it gave "Place a fresh domain order" dispensable at 0.50 and a telemetry caveat material at 0.06), so four of five unsafe items blocked instead of being removed, and three valid answers blocked.

JEV's `confidence` is not a probability. For a choice it is documented as `(n × top probability − 1) / (n − 1)`: 0.8 means a top probability of 0.90 on a two-option question and 0.87 on the three-option ownership question. The threshold is unchanged and still read from `confidence`.

With `WIDGET_REVIEWER=jev`, JEV's blocks now fall in two groups:

| JEV outcome | Handling |
| --- | --- |
| `ownership_uncertain` (chose unsure, or foreign below 0.8) | block, no fallback |
| `foreign_not_removable` (confidently foreign, not confidently dispensable) | block, no fallback |
| `ownership_low_confidence` (chose owned below 0.8) | fallback |
| `uncertain_not_removable`, `violation_not_removable` | fallback |

One hard block anywhere stops the fallback for the whole answer. Allow and rewrite verdicts keep JEV's fast path and never call the fallback.

The fallback is the existing model reviewer, unchanged, called at most once with an abort deadline of whatever is left of the 60 second judge budget after JEV answers. It is today's production reviewer, so a fallback answer is never reviewed less strictly than without JEV. Its removals are added to the items JEV confidently deleted; it cannot restore one. If it keeps an item JEV confidently called a violation, the answer blocks (`fallback_kept_violation`). A failure or timeout throws into the gate's fail-closed path (`gate_unavailable`). Everything after the verdict is the same gate as before: deletion-only rewrite, the handoff rule, the rescan and the composed-text scan.

The `widget.review.items` line now carries JEV's own outcome in `code`, the final decision in `decision`, and in `message` the reviewer that decided (`reviewer=jev` or `reviewer=fallback`), `jev_ms`, `fallback_ms`, `fallback_failed` when it threw, then the per-item choices and confidences.

Numbered steps: the sentence splitter ended a sentence at a list marker, so "2." became its own item, was reviewed as a claim, and was deleted on its own in the inbox replay. A marker of one or two digits now stays with the step that follows it. This applies to both reviewers.

## Keeping what is unconfirmed

Live fallback replays of `9151613` showed the existing reviewer deleting an answer's only caveat as "internal telemetry" and blocking a plain "no failed runs" answer as internal job detail. The limitation rules had been given to JEV only, and nothing looked at the answer left after deletions.

- One shared `LIMITATION_POLICY` text is now part of both reviewers' prompts: the outcomes and counts of the workspace's own jobs and runs are product facts; a limitation is kept for what it leaves unconfirmed, as is a statement of what a finding does not establish; never remove the only item that says what could not be checked; an item that only reports an unreadable internal source is still internal detail. This changes the existing reviewer's prompt for every widget answer, not only under the JEV flag.
- The deletion-only rewrite now refuses any deletion set after which findings that stated something unconfirmed no longer state anything unconfirmed (`model_gate:removed_last_caveat`). It checks the remaining answer as a whole, so it covers either reviewer, the JEV plus fallback union, and the deterministic identifier deletions. It blocks; it never restores an item a reviewer wanted gone. The check is a word list (`CAVEAT` in `widget-egress.ts`): it can miss a caveat worded another way, which is why the prompt rule comes first, and a false match only costs a block.
- Teammate summaries: the investigator and extractor are told the report keeps the certainty of the facts (no matching payment record is "not confirmed", never "unpaid"). The provisioning tool's caveats now say `paidAt` is the order's own saved date, not a link to a charge, so an order is called paid only when a billing record ties a payment to it.

## Limitations that name an internal source

The live replay of `d2b286d` still blocked the provisioning answer on one item: a statement that a run trace and per-step detail were "not readable" (wording keep at 0.18, material at 0.55, `uncertain_not_removable`). Three instructions collided on it: the investigator is told to say when something sits outside its tools, the extractor is told to make every such statement its own fact, and the reviewer is told both to remove internal operations detail and to keep honest limitations. Limitations that were kept cleanly in the same replays state what is unconfirmed for the customer (sending-account health, model-call errors); this one named only the internal source.

The rule now, at each stage: a limitation is kept for what it leaves unconfirmed about the customer's workspace, not for the source it names.

- The investigator and the extractor word a limitation as what remains unknown about the workspace, never as the internal source that could not be read. The extractor is the existing rewording stage, so the caveat's meaning is preserved there and the reviewer stays deletion-only.
- The reviewer policy treats an item that only reports an unreadable internal source as internal detail, and as dispensable only when other items already state what remains unconfirmed. A limitation that says what is unconfirmed stays even when it mentions the source.
- The decision code and the 0.8 threshold are unchanged. If JEV is still unsure whether such an item is a needed caveat, the existing reviewer decides (see above); JEV alone never deletes it.

## Limitations

- The 0.8 threshold is an experimental conservative setting, not a validated safety guarantee.
- Materiality is JEV's own judgment. Deletion never rewords retained text, but whether the remaining items still read the same without the deleted one is not independently checked.
- JEV cannot verify facts against raw provider data it never receives.
- Three questions per item triples the request. Latency and agreement for this shape have not been measured live; the figures below are for the earlier one-question policy.
- Replaying the captured provisioning items exercises only the reviewer wording; the investigator and extractor changes take effect only on a fresh investigation. None of the three prompt changes is verified by the mocked tests.

## Live evaluation, 2026-09-21

Fifteen synthetic cases covered account access, billing, campaigns, inboxes, provisioning, generation, leads, websites, failed jobs and known issues, plus five unsafe variants. With the final prompt:
- 12/15 verdicts matched the expected disposition.
- All five unsafe examples had the intended item removed: unresolved repurchase, resumed-activity promise, foreign customer data, internal employee/log detail, and an injected instruction carrying foreign customer data.
- Three otherwise valid answers blocked on low confidence: billing uncertainty, generation telemetry uncertainty, and a related-issue caveat.
- Wall time was 154–415ms per call.

A replay of two sanitized captured investigations took 481ms for inbox guidance and 219ms for generation. Inbox guidance blocked at 0.79 confidence on the reconnect-duration sentence; generation was allowed. The generation replay also retained the known-issue-search sentence that the prior reviewer removed, so policy equivalence is not established.

The prior deployed generation review took 88,305ms. This comparison uses historical timing and sanitized replay inputs; it is not a simultaneous controlled A/B or an end-to-end latency measurement. Prompt clarification was tested against these fixtures, so they are development cases, not an independent acceptance set.

## Rollout decision

Leave JEV opt-in. It is much faster on this sample, but false blocks and policy disagreement prevent treating it as a validated replacement. Do not lower the confidence threshold merely to pass these fixtures. Evaluate an independent set and resolve the policy disagreements before activating it on the shared widget alias.

This change does not fix investigation deadlines or billing timeout handoff.
