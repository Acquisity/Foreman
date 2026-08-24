---
name: engineering-handoff
description: Convert an independently approved customer-bug diagnosis into one causal Linear master and bounded source-report relationships, with an implementation-ready outcome and regression seam. Use only after the critic approves the current evidence revision.
---

# Engineering handoff

Create durable engineering work from an approved diagnosis without turning every customer report into a separate engineering investigation. The existing Linear workflow owns valid team, project, labels, priority values, assignees, statuses, and API mechanics. This skill owns causal grouping, content boundaries, idempotency, and the implementation contract.

## Preconditions

Require all of:

- a settled `Bug` classification;
- a current `customer-bug-diagnosis` output;
- `triage-critic: APPROVE` for the exact evidence revision;
- the opaque approval id returned by `read_triage_review_verdict` for that revision;
- an `incident-hotlane` route;
- a source customer-report issue or an authorized plan to create it; and
- a current search of Linear for candidate causal masters.

If any precondition is missing, do not create or change a master relationship. Record the blocker or use a non-structural `related` link while a person reviews the case.

## Match by cause, not symptom

Parent the source report to an existing master only when all material parts match:

- the same failing invariant or decision;
- the same reachable code, job, state transition, provider failure, or dependency boundary;
- compatible triggering conditions; and
- the proposed fix would prevent both reports.

A shared symptom, error string, component, provider, or customer outcome is insufficient. Different symptoms may share a master when the same cause and fix are proved. Similar symptoms with different causes remain separate.

When uncertain, relate the issues and use `needs-human`; do not parent them speculatively.

## Source report boundary

The source report preserves customer-specific context:

- Intercom or Slack source link;
- workspace and customer identity;
- screenshots, raw conversation evidence, production rows, and bounded logs;
- customer-specific timeline and unblock; and
- the attached investigation document.

Keep the source report labelled as customer or Intercom reported when those labels exist. It is evidence, not the engineering implementation owner.

## Root-cause master boundary

The shared master contains only sanitized, aggregate engineering context:

```markdown
## Overview

What is broken and why it matters in plain language.

## Problem

The observable user or operator outcome.

## Root cause

The failing invariant and causal path, including current repository SHA, files,
functions, jobs, or provider boundary.

## Impact and blast radius

Confirmed affected and potentially exposed counts kept separate, with source,
window, timestamp, and limitations. State core-function and hotlane decisions.

## Proposed outcome

The end-to-end behavior that must change, without prescribing unnecessary
implementation details.

## Scope

Included behavior, important exclusions, dependencies, containment, recovery,
prevention, and observability work.

## Regression seam

The public boundary, trigger, and observable red-before/green-after behavior.

## Done when

- Observable acceptance criterion.
- Observable acceptance criterion.
- A regression test proves the causal mechanism at the named seam.
- Required recovery and observability outcomes are complete or separately owned.

## Reports

Links to the customer-report child issues only. No customer-identifying detail.
```

Write acceptance criteria as outcomes another engineer or reviewer can verify. Do not turn the ticket into a layer-by-layer implementation prescription unless the evidence requires a specific safety constraint.

## Separate independently deliverable outcomes

Use child or related implementation tickets only when containment, recovery/backfill, prevention, or observability are independently deliverable, have different owners or risk, or can ship separately. These implementation children are not customer reports and do not count toward affected-workspace totals.

Keep one causal master regardless of the number of reports or implementation tasks.

## Safe write sequence

Immediately before writing:

1. Re-search current Linear using root cause, code path, provider failure, and symptom, paging each query to completion. Compare the exact eligible candidate identifiers and verified creation timestamps, the selected current or stale master, and every planned relationship against the approved packet. If a candidate appeared, disappeared, changed eligibility, or changed the selected write after attempt one, stop and use attempt two for a new packet revision and a complete all-criteria review. If this happens after attempt two, route to a person. The final search may confirm the packet; it may not silently replace it.
2. Call `read_triage_review_verdict` for the unchanged evidence revision and require its server-attested `APPROVE` plus opaque `approvalId`. Revalidate the selected master candidate against the approved packet.
3. Match the complete eligible candidate set by cause. If an existing master owns the cause, read both issues and their relations first. Parent the source only when that parent is absent, append a related link only when that exact relation is absent, and link the source report from the master only when that exact link is absent. Add only aggregate evidence, recount blast radius, and inherit its owner. Do not reserve or create. Treat an exact existing relation as successful idempotent state, not a reason to append it again.
4. If no eligible existing master owns the cause, call `reserve_triage_master` with the opaque `criticApprovalId` and source issue id. The server reads stable causal identity keys and the reviewed master generation from the attested packet. A normal first master uses the initial generation. A 30-day workflow replacing a reviewed stale same-cause master uses that stale master id as the next generation. Only the transaction that atomically reserves that exact causal generation receives `acquired: true`; every conflict or replay fails closed. When it returns `existingMasterIssueId` and `existingMasterCreatedAt`, apply the active workflow's recency rule before reuse. When it returns `reservation_in_progress` or is unavailable, stop and reconcile against Linear or route to a person. An unresolved reservation never expires into permission for another create.
5. Only the caller that receives `acquired: true` may create exactly one master. Keep its `reservationId`.
6. Parent the source report once and preserve existing valid labels as a union when the API replaces labels.
7. Read back the master, source report, parent relation, labels, assignee, project, priority, and links.
8. After a newly created master passes readback, call `complete_triage_master_reservation` with the reservation id and master issue id. The tool independently reads the issue's `createdAt` from Linear and binds it only when it is consistent with the active reservation. If completion is ambiguous, retain the created issue identifier and route the mismatch to a person. Never create another master.

If readback disagrees with the intended write, stop and report the mismatch. Never create a second master as a recovery strategy.

Changing a diagnosis or moving a report between masters requires a new evidence revision, critic approval, and an audit comment on both affected tickets. Never silently remove or re-parent a report.

## Final communication

The source report comment should lead with:

1. the customer unblock;
2. the plain-language finding and cause;
3. confirmed affected-workspace count or honest limitation;
4. whether it is hotlane; and
5. the next action and investigation-document link.

Keep code paths, SQL, raw logs, identity resolution, and routing rationale in the private investigation document. Shared Slack communication should explain what was found and what happens next without exposing customer-specific evidence.

## Completion contract

The handoff is complete only when:

- exactly one causal master owns the engineering outcome;
- the source report is linked and parented correctly;
- customer-specific evidence remains bounded to the source report;
- blast radius, hotlane state, owner, priority, regression seam, and acceptance criteria are present;
- the structural writes have been read back successfully; and
- support has a plain-language unblock and next step.
