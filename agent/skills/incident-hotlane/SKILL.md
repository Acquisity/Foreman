---
description: "Assess whether a completed triage investigation describes an incident: core-function impact, blast radius, containment, recovery, prevention, observability, and whether to propose the fast-lane label. Assessment only; it changes nothing. Load after Stage 5 proposes handling and before the critic reviews it."
---

# Incident hotlane assessment

Decide, from the completed investigation, whether this failure needs urgent handling and what work that implies. Route by user and business impact, not by complaint volume or how the reporter phrased it. One affected workspace is enough when a core function is blocked or materially impaired.

This skill performs no writes. It does not change Linear, assign work, create a master, send a message, or touch production. It returns a structured assessment that Foreman includes in the critic review and acts on only after the review has settled, in Stage 6. If a challenge overturns it, there is nothing to roll back.

## Evaluate core-function impact

Name the exact user objective the customer was pursuing. From the evidence in the investigation document, decide whether the failure:

- completely blocks it;
- materially impairs it or produces materially incorrect results;
- silently skips paid or expected work;
- risks data loss, corruption, security, or privacy;
- causes active billing, revenue, provider-cost, or customer-trust harm;
- has no reasonable safe workaround; or
- is cosmetic, inconvenient, or limited to a non-core edge case.

Do not infer impact from ticket count. Several reports can describe a low-impact limitation; one report can prove a critical outage.

## Route

Propose `HOTLANE` when current evidence confirms any of:

- a core workflow is blocked or materially impaired;
- data is lost, corrupted, exposed, or written to the wrong tenant;
- permissions, authentication, security, or privacy controls fail;
- paid work is silently skipped or the product reports false success;
- customers are actively charged or materially financially harmed incorrectly;
- confirmed material revenue loss, uncontrolled provider-cost burn, or customer-trust harm needs immediate containment;
- a high-frequency failure hits a core path; or
- no safe workaround exists for a material customer outcome.

Propose `STANDARD_ENGINEERING` for a confirmed defect that meets none of those. Propose `NOT_ENGINEERING` for User Error, Platform Limitation, expected behavior, or the unproven stop.

When evidence points at a high-risk condition but a critical evidence lane was unavailable, so the condition cannot be confirmed, return `NEEDS_HUMAN_URGENT`. Do not downgrade it to routine work. `NEEDS_HUMAN_URGENT` means Foreman stops before any settled classification, priority, label, master, or announcement, keeps the investigation document, and routes the case to a person with a clearly labelled provisional note that a possible high-risk incident is awaiting confirmation. Foreman does that; this skill only returns the route.

A `HOTLANE` proposal maps to the existing `fast-lane` label on the ENG team. Stage 6 applies it after approval, alongside the numeric priority Stage 5 already decided. This skill does not set priority; Stage 5 owns it.

## Separate the four workstreams

For a `HOTLANE` route, keep these distinct so each can be owned and delivered on its own:

1. Containment: stop additional harm without hiding evidence.
2. Customer recovery: restore affected customers, replay missed work, correct safe records, or provide a verified workaround.
3. Permanent prevention: fix the causal mechanism and add regression protection.
4. Observability: add the signal needed to detect recurrence and measure affected users when current telemetry is inadequate.

Each is recommended work for `engineering-handoff` to file, unless an existing authorized workflow already performs it. A workaround or completed recovery never lowers the defect's priority; a permanent fix never recovers already affected customers by itself.

## Blast radius

Carry two figures separately:

- `confirmed_affected`: distinct workspaces or users with direct evidence of the failure;
- `potentially_exposed`: distinct workspaces or users that traversed the affected path without confirmed failure.

Include the measurement window, source, date counted, and limitations. `Unknown` is allowed when a measurement was genuinely attempted and the missing telemetry is named; it is not allowed as a substitute for trying.

## Output contract

Return:

- `core_function`
- `impact`: `BLOCKED | MATERIALLY_IMPAIRED | INCORRECT_RESULT | SILENTLY_SKIPPED | DATA_OR_SECURITY_RISK | MONEY_IMPACT | MATERIAL_BUSINESS_HARM | NON_CORE | UNCONFIRMED`. `UNCONFIRMED` is for `NEEDS_HUMAN_URGENT` only: name the suspected condition in `rationale` rather than asserting a confirmed state.
- `route`: `HOTLANE | STANDARD_ENGINEERING | NOT_ENGINEERING | NEEDS_HUMAN_URGENT`
- `proposed_label`: `fast-lane` for `HOTLANE`, otherwise `none`
- `rationale`
- `workaround_available`
- `containment`, `customer_recovery`, `permanent_prevention`, `observability_gap`: recommended work, each `None needed: <reason>` when evidence shows nothing is required
- `blast_radius`: one object with `confirmed_affected`, `potentially_exposed`, optional `affected_org_count` and `affected_user_count`, `method_or_source`, `window`, `measured_at`, and `limitations`
- `notification_recommendation`: who should hear about this and what they need to know, for Foreman to act on after approval; this skill sends nothing and names no channel that the current triage workflow does not already use
- `unknowns`
