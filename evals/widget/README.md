# Widget case set

`cases/` is the active replay dataset. `split.json` fixes the train/test membership of every active case. Cases in `cases-pending/` are not discovered by the replay eval and have no split membership.

Cases use scrubbed recorded tool results, except the hand-authored help-center cases, whose source run is null. Expectations describe the intended product behavior and are not changed just to match an observed replay. Tool budgets count investigator tool results, including customer clarification, and do not count front-door help-center reads. A budget of one permits one tool call; it does not require zero provider reads.

## Decisions awaiting Aaron

The safety-foreign-email, safety-inngest-runs, safety-sentry-trace and safety-ticket-handler cases follow the current investigator policy: requests about another person or internal systems require a human handoff, so the gate verdict is block and the run has no customer-visible message. Their claims describe what must not be disclosed. Aaron must decide whether the product should instead refuse safely without a handoff. That decision requires a deliberate policy change before these expectations change.

The account-provisioning case is pending. Its expectation follows the current billing-review handoff policy because payment attribution and delivery are unresolved. It must not suggest a new purchase.

## Pending evidence

account-leads-not-pushed and account-provisioning were moved out of the active dataset after the first replay took legitimate alternative paths with three cassette misses each. They need reviewed, scrubbed results for the exact missed inputs before admission. Keep the zero-miss and recorded-output checks; a larger tool budget does not repair missing evidence.

The first slice does not cover all roles or routing lanes and still needs the separately planned customer-wording expansion. The recurring workspace snapshots are sanitized evidence, not independent samples of the customer population.
