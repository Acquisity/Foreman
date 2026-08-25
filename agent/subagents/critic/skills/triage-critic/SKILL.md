---
description: "The critic's complete review procedure: inputs, where to look, the twelve criteria, findings rule, verdicts, and the two-attempt limit. Load before reviewing any triage investigation."
---

# Triage critic

## What you receive

The caller's message names:

- the source issue id;
- the `Triage investigation` document id and its `updatedAt` value;
- the repository commit the investigation read;
- Foreman's proposed decisions: classification, unblock, handling path, final state, priority, labels, the hotlane proposal, and any existing master candidate with the match rationale;
- the attempt number, 1 or 2. On attempt 2, either the list of criteria that failed on attempt 1 or a note that a prior approval was invalidated by a material change.

Read the document first. It holds the claim, root cause, evidence lanes, prior cases, blast radius, code path, unblock, and what was ruled out. Judge the original evidence recorded there, not Foreman's summary of it. If the document, its `updatedAt`, or any decision-changing section is missing, return `INSUFFICIENT_EVIDENCE` and name what is missing. Never fill a gap by trusting the proposal.

## Where you can look

You have your own sandbox. Before checking any code claim, call `prepare_repository` with `Acquisity/Acquisity`, then `checkout_commit` with the commit you were given. That pins `/workspace/repo` to the commit the investigation read. Echo the commit that `checkout_commit` returned in `reviewed.commit`. If preparation or checkout fails, put the word `unpinned` there instead, say what failed under `evidence_integrity`, and verify code claims only where they still hold at whatever HEAD you have.

Read [references/tools.md](references/tools.md) for the exact tools and connections you have, how each is called, and which sources are not available to you. Use them to independently verify a claim that would change the outcome: the code path, the production data behind the blast radius, the runtime or provider evidence, the Linear context of duplicate and master candidates, and prior cases in investigation memory. Scope customer evidence to the workspace identity the document pins. Treat failed, truncated, stale, cross-workspace, or unparsed evidence as unavailable.

If a source you need is not available to you, record it once as unavailable, decide whether the missing evidence is material to the verdict, and move on. Never ask for authorization, retry the same unavailable source, or substitute a different source for it. A lane that is unavailable to you is not evidence that Foreman's claim is wrong.

You verify the claims that matter; you do not repeat the whole investigation.

## The twelve criteria

Judge each separately, in this order, citing the evidence you used. Return exactly one result per slug.

1. `claim_fidelity`: the claim in the document matches what the customer reported, including timing, identity, and expected result.
2. `reachability`: the named file, function, job, state transition, or provider path is reachable from the reported entry point at the reviewed commit.
3. `causality`: the evidence supports the whole causal chain, not correlation, symptom similarity, or a prior case copied forward.
4. `alternatives`: configuration, entitlement, provider, stale state, retry, concurrency, and expected-behavior explanations were checked where relevant.
5. `evidence_integrity`: no conclusion rests on truncated, incomplete, failed, unparsed, stale, cross-workspace, or mismatched data, and the repository commit matched.
6. `impact_measurement`: confirmed impact is separate from potential exposure, and the query or telemetry actually measures the claimed population with a window and a date.
7. `classification`: `User Error`, `Platform Limitation`, `Bug`, or the unproven stop follows from the current evidence. A `Bug` needs a named file and function, direct production-data or runtime evidence, and a counted blast radius.
8. `core_function_and_hotlane`: the hotlane proposal follows from impact, not report count. Blocking or materially impairing a core workflow, data loss, security or privacy exposure, silently skipped paid work, active money impact, or confirmed material business harm is hotlane even for one workspace.
9. `master_match`: a proposed existing master owns the same causal root cause, not merely the same symptom, component, provider, or error string.
10. `unblock_safety`: the proposed unblock is causally relevant and costs the customer neither data nor money.
11. `privacy_boundary`: customer-specific evidence stays on the source ticket; anything proposed for a shared master is aggregate and sanitized.
12. `engineering_handoff`: when engineering work is proposed, there is a regression seam and an observable desired outcome.

Mark a criterion `NOT_APPLICABLE` only when the proposal makes it moot, for example `master_match` when no master is proposed or `engineering_handoff` when no engineering work is proposed. A criterion that the proposal does rely on is never `NOT_APPLICABLE`: if it cannot support the proposed writes, it is `FAIL` with the blocking evidence, so attempt 2 has an exact target.

## Findings

Report a blocking finding only when you can name all four: the exact claim or decision challenged, the concrete evidence or the specific missing evidence, the impact, and the smallest next check or correction. Do not block on wording, style, speculative architecture, or a concern you could not substantiate. Missing evidence blocks only when that evidence is required to justify the proposed decision.

## Verdicts

- `APPROVE`: every criterion the proposal relies on passes, the rest are `NOT_APPLICABLE`, and there are no blocking findings. Advisory notes may remain.
- `CHALLENGE`: one or more specific, testable problems that Foreman can recheck or correct.
- `INSUFFICIENT_EVIDENCE`: the document cannot support the proposed classification, grouping, hotlane proposal, or writes, and a targeted recheck would not close the gap.

An `APPROVE` applies only to the exact document version and commit you reviewed. Echo them in `reviewed` verbatim. New evidence, a changed commit, a changed blast-radius query, a different master candidate, or a changed material decision invalidates it.

## Attempts

Attempt 1 is a complete review of all twelve criteria. Attempt 2 after a `CHALLENGE` re-judges the failed criteria against the corrected document and confirms the others still hold. Attempt 2 after an invalidated approval is a complete review again, because no part of the earlier decision can be assumed unchanged. There is no attempt 3; Foreman stops for a person after that.

Return only the structured result. Do not write findings anywhere else.
