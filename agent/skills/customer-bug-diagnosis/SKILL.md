---
name: customer-bug-diagnosis
description: Build an evidence-backed causal diagnosis for a customer-reported product failure before classification, routing, or Linear engineering writes. Use after a testable customer claim and workspace identity are available; do not use for billing decisions or implementation work.
---

# Customer bug diagnosis

Produce a falsifiable explanation of what happened, what evidence supports it, what remains uncertain, and where engineering should lock the behavior with a regression test. This skill is read-only. It does not edit repositories, mutate production, communicate with customers, or create Linear work.

Load the existing intake-specific triage skill first. That skill owns identity resolution, available tools, evidence privacy, ticket state, and customer communication. This skill owns the diagnosis discipline shared by Linear and Intercom intake.

## Required inputs

- Original report and source link.
- One testable claim: observed behavior, expected behavior, time, and affected workspace, campaign, record, component, or provider.
- The pinned workspace identity when customer-specific evidence is required.
- The current repository worktree and commit SHA when code is relevant.
- Available production, runtime, provider, analytics, conversation, and visual evidence.

If the claim cannot be stated honestly, return the narrowest supported claim, the assumption being made, and the exact clarification required. Do not silently guess.

## 1. Build a feedback signal

Prefer a safe, repeatable signal that exercises the reported path and distinguishes the exact customer symptom from nearby failures:

1. Existing focused test or safe read-only command.
2. Replaying a captured request, event, trace, or provider record.
3. A safe browser reproduction of the visible workflow.
4. A narrow comparison of affected and known-good records.
5. A production-forensics case when replay is unsafe or impossible.

Never write to production or trigger customer-visible actions to obtain a reproduction. A browser or API action that could send messages, charge money, delete data, provision resources, or alter customer state requires a person.

When no replay is possible, the production-forensics case must contain:

- a correlated timeline with stable identifiers and timestamps;
- the deployed or inspected code SHA and the exact writer, reader, job, or provider path;
- current data or runtime evidence supporting the causal chain;
- plausible alternatives checked and ruled out;
- a falsifiable explanation naming what observation would disprove it; and
- an explicit confidence statement separating verified fact from inference.

If neither a valid feedback signal nor a complete forensics case is available, return `UNPROVEN` and name the missing access or artifact. Plausibility is not a root cause.

## 2. Reproduce or minimise

Confirm the signal matches the user's reported outcome. Reduce the scenario to the smallest set of data, configuration, timing, provider state, and steps that still explains or reproduces the failure. Do not substitute a different failure because it is easier to observe.

For intermittent issues, report the observed rate and time window. The goal is a usable signal, not a claim of determinism the evidence does not support.

## 3. Test competing causes

Before settling on a cause, generate three to five ranked, falsifiable hypotheses when the evidence allows multiple explanations. For each hypothesis, state the observation that would support it and the observation that would disprove it. Check one discriminating variable at a time.

At minimum consider:

- customer or workspace configuration;
- permissions, plan, entitlement, limits, credits, or expected behavior;
- provider or platform limitation;
- stale, partial, duplicated, or incorrectly ordered state;
- retry, concurrency, async, scheduling, or partial-failure behavior;
- deployment or configuration drift; and
- an internal product defect.

Record important eliminated causes so the next investigator does not repeat them.

## 4. Maintain an evidence ledger

For every relevant lane, record one of:

- `VERIFIED`: what was read, when, and what it proves.
- `CONTRADICTED`: what evidence conflicts with the claim or hypothesis.
- `NOT_APPLICABLE`: why the lane cannot affect this path.
- `COULD_NOT_RUN`: the precise tool, access, identifier, or telemetry blocker.

Keep customer-specific evidence on the source report or its private investigation document. Shared outputs may contain aggregate counts, sanitized error signatures, code paths, and causal conclusions only.

Treat incomplete, truncated, oversized, failed, raw, or unparsed results as `COULD_NOT_RUN`, never as zero or absence.

## 5. State the causal conclusion

A root cause names the failing decision or invariant, not merely the visible mechanism. State:

1. What invariant or expected contract failed.
2. Which reachable code, job, state transition, configuration, or provider behavior violated it.
3. How that violation produced the customer's exact outcome.
4. Which evidence establishes each link.
5. What observation would disprove the explanation.

Separate `Verified facts`, `Inference`, and `Unknowns`. Use `HIGH`, `MEDIUM`, or `LOW` confidence and explain the limiting evidence.

Also name a stable causal identity for concurrency control. Use lowercase identifier keys, not prose: one product invariant key, one or more reachable code/job/provider path keys, one or more trigger-condition keys, and one prevention-outcome key. Prefer repository paths plus function or job names and established product-domain identifiers. Independent investigations of the same cause must converge on the same keys even when their prose differs; different causes must not share them. If stable keys cannot be justified, keep the result `UNPROVEN` or route the master decision to a person.

## 6. Measure impact honestly

Always attempt a current blast-radius measurement using the system that owns the question. Count distinct affected workspaces and users once, and separately record potentially exposed workspaces when useful.

An exact number is preferred but is not a prerequisite for confirming a directly reproduced or forensically proved bug. When exact measurement is unavailable, return the tightest supported bound or `Unknown`, the measurement attempted, its window, and the missing telemetry. Never turn potential exposure into confirmed impact.

## 7. Name the regression seam and customer unblock

Identify the public boundary where engineering should prove the faulty behavior red before the fix and green after it. Describe the input, expected observable output, and why this seam exercises the real failure. Do not write the test or implementation during intake.

Separately identify the safest current unblock, who can perform it, whether it has happened, and whether it risks data or money. A workaround does not reduce defect severity.

## Output contract

Return:

- `claim`
- `diagnosis`, using the exact packet field names:
  - `mode`: `REPRODUCTION | PRODUCTION_FORENSICS | UNPROVEN`
  - `rootCause`, `verifiedFacts`, `inference`, `ruledOut`, and `unknowns`
  - `hypotheses`: one to five objects with `rank`, `hypothesis`, `status`, `supportingObservation`, and `disprovingObservation`
  - `evidenceLedger`: entries with `lane`, `status`, `summary`, and `observedAt`; a verified or contradicted entry also has `handle`, while `COULD_NOT_RUN` has `blockerReason`
  - `blastRadius`: `confirmedAffected`, `potentiallyExposed`, optional `affectedOrgCount` and `affectedUserCount`, optional `countedAt` date, `method`, `window`, and `limitations`
  - `codeAnchor`: `repository`, `commitSha`, and one or more exact code, function, job, state-transition, or provider `paths`
  - `causalIdentity`: lowercase `repositoryKey` matching the code anchor, plus `failingInvariantKey`, `causalPathKeys`, `triggerConditionKeys`, and `preventionOutcomeKey`
  - `confidence`, `disprovingObservation`, `regressionSeam`, and `customerUnblock`

This skill returns diagnosis, not a final classification or write decision. The intake router evaluates the diagnosis and classifies it. Only a remaining candidate `Bug` proceeds to the independent critic before structural decisions.
