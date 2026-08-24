---
name: incident-hotlane
description: Decide whether a confirmed or high-risk customer-reported failure requires immediate hotlane or incident handling, and separate containment, recovery, prevention, and notification. Use after diagnosis and before priority, master-ticket, or incident-channel writes.
---

# Incident and hotlane handling

Route by user and business impact, not complaint volume or reporter urgency. One affected workspace is enough when a core function is blocked or materially impaired.

The intake skill remains the authority for Linear metadata, current routing roster, and notification destinations. This skill supplies the impact decision and required handoff fields.

## Evaluate core-function impact

Name the exact user objective and determine whether the failure:

- completely blocks it;
- materially impairs it or produces materially incorrect results;
- silently skips paid or expected work;
- risks data loss, corruption, security, or privacy;
- causes active billing, revenue, provider-cost, or customer-trust harm;
- has no reasonable safe workaround; or
- is cosmetic, inconvenient, or limited to a non-core edge case.

Do not infer impact from ticket count. Multiple reports can describe a low-impact limitation; one report can prove a critical outage.

## Hotlane decision

Set `HOTLANE` immediately when current evidence confirms any of:

- a core workflow is blocked or materially impaired;
- data is lost, corrupted, exposed, or written to the wrong tenant;
- permissions, authentication, security, or privacy controls fail;
- paid work is silently skipped or the product reports false success;
- customers are actively charged or materially financially harmed incorrectly;
- confirmed material revenue loss, uncontrolled provider-cost burn, or customer-trust harm requires immediate containment;
- a high-frequency failure affects a core path; or
- no safe workaround exists for a material customer outcome.

Set `STANDARD_ENGINEERING` for a confirmed defect that does not meet those conditions. Set `NOT_ENGINEERING` for User Error, Platform Limitation, expected behavior, or an unproven claim.

When evidence suggests a high-risk condition but cannot confirm it because a critical lane is unavailable, return `NEEDS_HUMAN_URGENT`; do not downgrade it to routine work.

`NEEDS_HUMAN_URGENT` is terminal for automated finalization. Send only the provisional escalation described below, route the case to a person, and stop before settled classification comments, priority or hotlane writes, master creation or relationships, incident announcements, and investigation-memory writes. It cannot fall through as an approved `Bug`, `HOTLANE`, or `STANDARD_ENGINEERING` result.

## Separate the four workstreams

For hotlane or incident handling, keep these distinct:

1. Containment: stop additional harm without hiding evidence.
2. Customer recovery: restore affected customers, replay missed work, correct safe records, or provide a verified workaround.
3. Permanent prevention: fix the causal mechanism and add regression protection.
4. Observability: add the signal needed to detect recurrence and measure affected users when current telemetry is inadequate.

A workaround or completed recovery does not lower the underlying defect priority. A permanent fix does not automatically recover already affected customers.

## Blast radius

Carry two figures separately:

- `confirmed_affected`: distinct workspaces or users with direct evidence of the failure;
- `potentially_exposed`: distinct workspaces or users that traversed the affected path but are not confirmed failures.

Include the measurement window, source, timestamp, and limitations. `Unknown` is allowed when the measurement was attempted and the missing telemetry is named.

## Critic and notification gate

Send the diagnosis, impact decision, blast-radius method, workaround, and proposed notification through `triage-critic` before structural writes or a settled incident announcement.

After approval:

- flag the master as hotlane immediately when qualified, even for one workspace;
- notify the relevant engineering or incident channel using the configured routing policy;
- notify customer support with the plain-language impact, current unblock, and next update expectation; and
- avoid copying customer-specific evidence into shared channels or the master.

If immediate human attention is required before the critic can complete, send only a clearly labelled `possible high-risk incident - confirmation in progress` escalation. Do not announce a settled cause prematurely.

## Output contract

Return:

- `core_function`
- `impact`: `BLOCKED | MATERIALLY_IMPAIRED | INCORRECT_RESULT | SILENTLY_SKIPPED | DATA_OR_SECURITY_RISK | MONEY_IMPACT | MATERIAL_BUSINESS_HARM | NON_CORE`
- `route`: `HOTLANE | STANDARD_ENGINEERING | NOT_ENGINEERING | NEEDS_HUMAN_URGENT`
- `rationale`
- `workaround_available`
- `containment`
- `customer_recovery`
- `permanent_prevention`
- `observability_gap`
- `blast_radius`: one object containing `confirmed_affected`, `potentially_exposed`, optional `affected_org_count` and `affected_user_count`, `method_or_source`, `window`, `measured_at`, and `limitations`
- `notification_recommendation`
- `unknowns`
