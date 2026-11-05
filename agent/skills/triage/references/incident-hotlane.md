# Incident hotlane assessment

Read this in the critic review, only for `review.kind` `bug`. It turns the `hotlane` field `decide_triage` returned into the work an incident implies. This assessment performs no writes: it does not change Linear, assign work, create a master, send a message, or touch production. For `HOTLANE` and `STANDARD_ENGINEERING`, Foreman includes the assessment in the critic review and acts on it only after the review has settled, in Stage 6. `NEEDS_HUMAN_URGENT` instead routes directly to a person before any critic review or settled decision.

## Route

Jev decides the route: take `route` (`HOTLANE`, `STANDARD_ENGINEERING`, or `NEEDS_HUMAN_URGENT`), `impact`, and `proposedLabel` from `decision.hotlane`, and put its notes in `rationale`. A re-run of `decide_triage` replaces them. Route by user and business impact, never by complaint volume: one workspace is enough when a core function is blocked.

`NEEDS_HUMAN_URGENT` means a high-risk condition could not be confirmed, either because a critical lane was unavailable or because a likely hotlane call fell below the confirmation bar. Do not downgrade it to routine work. Foreman stops before any settled classification, priority, label, master, or announcement, and hands the case to a person with a provisional note. A `HOTLANE` proposal maps to the existing `fast-lane` label, which `engineering-handoff` applies to the master only, never to the customer ticket. This assessment does not set priority; `decide_triage` does.

## Separate the four workstreams

For a `HOTLANE` route, keep these distinct so each can be owned and delivered on its own:

1. Containment: stop additional harm without hiding evidence.
2. Customer recovery: restore affected customers, replay missed work, correct safe records, or provide a verified workaround.
3. Permanent prevention: fix the causal mechanism and add regression protection.
4. Observability: add the signal needed to detect recurrence and measure affected users when current telemetry is inadequate.

Each is recommended work for `engineering-handoff` to file, unless an existing authorized workflow already performs it. A workaround or completed recovery never lowers the defect's priority; a permanent fix never recovers already affected customers by itself.

## Blast radius

Carry two figures separately: `confirmed_affected` (distinct workspaces or users with direct evidence of the failure) and `potentially_exposed` (those that traversed the affected path without confirmed failure). Include the measurement window, source, date counted, and limitations. `Unknown` is allowed only when a measurement was attempted and the missing telemetry is named.

## Output contract

Return `core_function`, `impact`, `route`, `proposed_label` (`fast-lane` for `HOTLANE`, otherwise `none`), `rationale`, `workaround_available`, the four workstreams as `containment`, `customer_recovery`, `permanent_prevention`, `observability_gap` (each `None needed: <reason>` when evidence shows nothing is required), `blast_radius` (`confirmed_affected`, `potentially_exposed`, optional `affected_org_count` and `affected_user_count`, `method_or_source`, `window`, `measured_at`, `limitations`), `notification_recommendation` (who should hear about this and what they need to know; this assessment sends nothing and names no new channel), and `unknowns`.
