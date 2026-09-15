# Fin run ownership and recovery

ENG-13766 adds one operational table in Foreman's existing private Postgres. It grants the customer model no database or memory capability. Apply `0007_fin_investigation_runs.sql` manually to the isolated Preview database before enabling this branch. Deploying code never runs a migration. Keep both support flags false and the Fin entry Preview-only.

## Contract

`POST /internal/fin/investigation` keeps the app-issued identity Bearer token. `action=start` accepts native `conversation_id`, `question`, and optional Intercom `callback_url`. The response returns an opaque UUID `run_handle`. It is a reference, not authorization. `action=result` accepts only the native `conversation_id` and `run_handle`; every call freshly verifies Acquisity identity/access and the original Intercom contact, app and workspace. A supplied session id, workspace or replacement callback is not accepted.

The database has one active row per app/conversation. The native customer-message history fingerprint deduplicates connector retries. Concurrent conversations use different rows. The first callback destination is immutable. A completed run releases its slot independently of Linear ticket state; a repeated start for the same native customer history returns its prior result. No model message is sent on a duplicate or result lookup.

Run references expire one hour after acceptance. Expiry denies customer retrieval and callback signalling; it does not cancel the investigation or release an unfinished slot. The two-minute event-stream observation limit is also not an investigation deadline. Native terminal events save the immutable result and report internally. A result lookup can recover a missing saved outcome from the exact persisted Eve session's event stream with an eight-second observation bound. It cannot start or steer work. A send whose acceptance is uncertain retains its slot; automatically starting a replacement could duplicate investigation or ticket creation. A missing session id after an interrupted dispatch is an operator recovery gap, not permission to guess another session.

## Callback and customer delivery

Intercom's current start connector exposes `callback_url` as an insecure, Fin-collected input. An allowed hostname/path does not attest its conversation. Therefore callbacks carry only a generic `ready` signal: no findings, ticket, identity, session id or run handle. The Procedure must use its own saved run reference and native conversation in Get Foreman Result. An incorrectly routed signal cannot authorize a cross-conversation read. There is one reserved bounded signal attempt; missed signals recover through the authenticated result connector, without a queue or automatic investigation retry.

Preserve the one-hour native webhook wait. After `ready`, invoke Get Foreman Result and use only its response. `pending` means continue waiting; `suppressed` has an empty message and means send no automated customer response. Do not use the signal message as findings. Never save the reference in a shared contact attribute: each Procedure/conversation must retain its own reference.

A complete native conversation read detects any public `admin` comment as takeover. Fin `bot` comments, assignment, closing and internal notes are not human replies. Later customer comments do not clear takeover. Incomplete history, changed source/contact/app, and unreadable provider state fail closed. After takeover, the investigation still runs and its normal internal Slack receipt receives the outcome. Callback signalling, synchronous results and recovered results are suppressed.

The check covers Foreman's delivery boundary. Intercom owns the later Fin message send; a teammate can reply after the checked lookup but before Fin sends. No trusted atomic check-and-send API exists in this implementation. Do not claim that interval is eliminated by a prompt. Human-takeover live acceptance remains gated on isolating the test conversation from Production support scanning and verifying Intercom's final-send ownership behavior. ENG-13767 owns the ten-minute progress presentation and teammate interaction; it must use the same ownership check and must not treat assignment as takeover.

## ENG-13769 interface

The saved bounded final report survives repeated retrieval and retains any confirmed ticket outcome already present in that report. Existing bounded ticket filing remains unchanged. This slice does not implement durable case/ticket association, uncertain ticket-write reconciliation, existing-case matching, or fresh-chat ticket status. Those remain ENG-13769. A later authenticated case lookup needs its own authorization; it must never loosen an expired or cross-conversation run reference. The current tool does not expose all four structured ticket outcomes, so this slice does not claim that interface is complete.

## Verification

Focused tests cover negative binding/expiry, revoked access, takeover during waiting, incomplete history, replay without dispatch and data-free callbacks. `scripts/test-fin-run-store.ts` exercises the actual SQL through the production Neon adapter against a disposable loopback `foreman_fin_test` PostgreSQL database, including twelve racing starts, independent conversations, out-of-order completions, immutable outcomes and completed-slot reuse with an open-ticket report. Set `FIN_TEST_DATABASE_URL` to that local database only. These are local tests, not live Preview acceptance.
