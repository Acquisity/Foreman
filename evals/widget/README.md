# Widget case set

`cases/` is the active replay dataset. `split.json` fixes the train/test membership of every active case. Cases in `cases-pending/` are not discovered by the replay eval and have no split membership.

Cases use scrubbed recorded tool results, except the hand-authored help-center cases, whose source run is null. Expectations describe the intended product behavior and are not changed just to match an observed replay. Tool budgets count investigator tool results, including customer clarification, and do not count front-door help-center reads. A budget of one permits one tool call; it does not require zero provider reads.

## Pulling production candidates

`pnpm widget:candidates [--since <ISO date>]` reads completed production `widget_support_runs` (point `FOREMAN_MEMORY_DATABASE_URL` at production; pass test workspaces as `--exclude-orgs <uuid,uuid>` or `WIDGET_CANDIDATES_EXCLUDE_ORGS`), groups them into conversations and flags help-center misses, requests for a person, handoffs, gate rewrites, customer pushback and investigations that only asked a clarifying question. Each flagged conversation gets a review entry in `.eve/widget-candidates/review-<time>.md`, which stays out of git because it holds raw customer text, and each flagged investigation run is converted with `pnpm widget:case` into `cases-pending/candidate-<run id>.json` with empty expectations; a conversion the leak check refuses is listed and skipped. `.eve/widget-candidates/state.json` remembers the last pull, so `--since` is needed only the first time and an immediate rerun adds nothing.

## Decisions awaiting Aaron

The safety-foreign-email, safety-inngest-runs, safety-sentry-trace and safety-ticket-handler cases expect a polite refusal with no handoff (Aaron, 2026-10-05): none of these customers asked for a person, and the requests do not call for a handoff, so the gate allows the reply and the claims describe what it must not disclose and that the chat stays with the widget.

The account-provisioning case is pending. Its expectation follows the current billing-review handoff policy because payment attribution and delivery are unresolved. It must not suggest a new purchase.

## Pending evidence

account-leads-not-pushed and account-provisioning were moved out of the active dataset after the first replay took legitimate alternative paths with three cassette misses each. They need reviewed, scrubbed results for the exact missed inputs before admission. prod-growth-plan-recording is pending for the same reason: its replay misses four reads every run. Keep the zero-miss and recorded-output checks; a larger tool budget does not repair missing evidence.

The first slice does not cover all roles or routing lanes and still needs the separately planned customer-wording expansion. The recurring workspace snapshots are sanitized evidence, not independent samples of the customer population.
