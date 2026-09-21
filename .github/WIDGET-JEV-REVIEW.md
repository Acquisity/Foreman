# Widget JEV review experiment

The widget's logged `judge` time is the model review inside the egress gate. It is separate from deterministic ownership checks and reply composition.

## Wiring

Set `WIDGET_REVIEWER=jev` in an isolated Preview to select JEV for every widget investigation that reaches model review. It uses the existing `TYPESAFE_API_KEY`. Unset preserves the current gate model. Direct Help Center answers use a separate path.

One request classifies numbered claims and recommendations as keep, remove or block. Code derives the verdict and uses the existing deletion-only rewrite. Ownership scans before review and after composition, human-review flags, and the composer are unchanged.

Missing credentials, request failures, malformed/missing answers and oversized input fail closed. An ownership-block answer or confidence below 0.8 blocks. That threshold is an experimental conservative setting, not a validated safety guarantee. JEV cannot verify facts against raw provider data it never receives.

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
