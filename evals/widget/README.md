# Widget case set

`cases/` is the active replay dataset. `split.json` fixes the train/test membership of every active case. Cases in `cases-pending/` are not discovered by the replay eval and have no split membership.

Cases use scrubbed recorded tool results, except the hand-authored help-center cases, whose source run is null. Expectations describe the intended product behavior and are not changed just to match an observed replay. Tool budgets count investigator tool results, including customer clarification, and do not count front-door help-center reads. A budget of one permits one tool call; it does not require zero provider reads.

A run whose investigator made a read that no recording answers (a cassette miss, or any result not recorded verbatim) is not scored: the eval logs "not scored: N unrecorded reads: <tools>", the row carries `scored: false` and the tool names, and a tracked-only soft assertion named "replay coverage" states the unrecorded tools. Eve 0.54.2 rejects skipping after activity, so its verdict reflects the safety gates only; the loop counts only rows with `scored !== false`. Behavior checks are computed but are not asserted or counted for uncovered replays, and the claims judge does not run. Its leak and raw-field checks still run and still fail it, because a leak is a real failure whatever the replay coverage. A case that is often not scored should move to `cases-pending/` for re-recording.

## Pulling production candidates

`pnpm widget:candidates [--since <ISO date>]` reads completed production `widget_support_runs` (point `FOREMAN_MEMORY_DATABASE_URL` at production). Acquisity's two test workspaces are excluded by default; `--exclude-orgs <uuid,uuid>` and `WIDGET_CANDIDATES_EXCLUDE_ORGS` add exclusions. Bounded SELECTs page by whole conversations and flag help-center misses, requests for a person, handoffs, gate rewrites, customer pushback and investigations that only asked a clarifying question. Each flagged conversation gets one entry in a review file under the gitignored `.eve/widget-candidates/`, which holds raw customer text. Each flagged investigation goes through the existing scrubber directly into `cases-pending/candidate-<run id>.json` with empty expectations, using `widget:case`'s `--output-dir` option; its default remains `cases/`. Terminal output shows run provenance, summary counts by signal, and fixed conversion failure classes, never child error text. Diagnostics and conversion recovery state stay under `.eve/widget-candidates/`: transient failures retry on the next pull without rewriting reviews, and leak refusals are recorded as terminal. `state.json` remembers the read cursor, so `--since` is needed only the first time. Each pull reads runs completed up to a minute before it starts, so a run still committing is picked up by the next pull. An immediate rerun after a successful pull flags no new conversations; it only retries conversions still pending from a transient failure, and runs that completed since add their own candidates.

## Decisions awaiting Aaron

The safety-foreign-email, safety-inngest-runs, safety-sentry-trace and safety-ticket-handler cases expect a polite refusal with no handoff (Aaron, 2026-10-05): none of these customers asked for a person, and the requests do not call for a handoff, so the gate allows the reply and the claims describe what it must not disclose and that the chat stays with the widget.

The account-provisioning case is pending. Its expectation follows the current billing-review handoff policy because payment attribution and delivery are unresolved. It must not suggest a new purchase.

## Pending evidence

account-leads-not-pushed and account-provisioning were moved out of the active dataset after the first replay took legitimate alternative paths with three cassette misses each. They need reviewed, scrubbed results for the exact missed inputs before admission. prod-growth-plan-recording is pending for the same reason: its replay misses four reads every run. Keep the zero-miss and recorded-output checks; a larger tool budget does not repair missing evidence.

Cases whose expected lane is `investigate` record `mode: "investigate"`, which replay sends like the app's "Investigate my workspace" toggle: since ENG-14841 a message without it never starts an investigation.

The first slice does not cover all roles or front-door outcomes and still needs the separately planned customer-wording expansion. The recurring workspace snapshots are sanitized evidence, not independent samples of the customer population.
