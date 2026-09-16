# Fin ticket association and status

ENG-13769 adds `0008_fin_cases.sql` after the run ownership migration. Apply both manually to the selected Preview database before deploying. Fin remains Preview-only and both scheduled support flags remain false.

The investigation records a filing or not-needed decision against its persisted run. Filing searches the native Intercom conversation ID, reads back the candidate's exact source, and confirms project, assignee, priority, classification labels, source attachment and Triage investigation document before claiming success. New issue and document writes each have one durable reservation. An uncertain response is reconciled by reads, never by repeating creation. An unresolved earlier creation blocks replacement work for that conversation. The final run saves a structured `newly-created`, `already-tracked`, `not-needed` or `failed` ticket outcome alongside its immutable findings. Missing verified decisions are reported as failed.

## Independent status connector

`POST /internal/fin/case` uses the existing app-issued Bearer identity token. Its strict JSON body accepts the native `conversation_id`, an optional opaque UUID `case_reference`, and optional `previous_status`. The status values are `triage`, `backlog`, `unstarted`, `started`, `completed` and `canceled`.

This entry reads existing cases without starting an investigation, taking a run slot or extending a run reference. Every lookup freshly verifies the current conversation and the saved original contact, app, user and workspace. Workspace membership alone and possession of a reference are insufficient. Original-chat cases take precedence; a fresh chat with several authorized reports returns bounded customer subjects and opaque references for clarification. Unavailable ownership or source evidence returns no ticket details. Public human replies suppress automated delivery.

Responses use `current`, `unchanged`, `clarification`, `unavailable` or `suppressed`. A current response includes `ticket_status`, `checked_at`, `case_reference` and a fixed customer-safe message. Fin must use that message, preserve unchanged wording, ask the clarification question when needed, and remain silent for `suppressed`. Internal descriptions, comments, parent/master details and Linear links are never returned. Completed means the ticket is marked done, not proof of deployment or resolution in the customer's workspace.

Configure a separate Intercom status connector and published Procedure path for follow-up questions, including while an investigation is active. Preserve the existing one-hour investigation webhook wait and original start/result connector ownership. Do not route a status request through investigation start or reuse an expired run handle.

## Verification

Unit tests cover confirmed outcomes, response-loss reconciliation, uncertain creation, source/routing mismatches, expired run independence, fresh-chat clarification, revoked access and takeover. The SQL harness exercises concurrent run and case claims, one creation/document reservation, owner isolation and immutable completion. Local tests do not prove live Executor grants, connector publication or Messenger behavior; record these separately against the exact Preview commit.
