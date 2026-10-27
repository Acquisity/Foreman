# Billing check for an inbox error

Do not load this reference unless `STAGE 4 COMPLETE: evidence record ready` existed before this file was opened and the report is about the customer's sending inboxes (disconnected, erroring, not sending). If either gate is absent, stop reading and return to the unfinished stage.

An inbox error is billing until this check says otherwise. Unpaid, lapsed or expired inboxes error every inbox at once, so when every inbox errors together, suspect non-payment first.

1. Read for the pinned workspace, with the reads `billing-triage` names (`read_billing_account`, then `read_autumn_billing`, then `read_stripe_billing`): whether the subscription is paid, and whether payments are failing.
2. Read whether the domains are live. No read here reaches the domain supplier, so use the domain and order state the product holds. When that state cannot establish it, record `domainsLive: null` and say in the document that supplier status is unverified.
3. Call `decide_triage` with `billingFacts`: the pinned `organizationId` (also passed as the top-level `organizationId`), the time you read them as `checkedAt`, `subscriptionPaid`, `paymentsFailing`, `domainsLive`, and the reads they came from as `source`. Use `null` for anything you could not establish, never a guess.

What `decide_triage` does with them: facts for another workspace, older than 24 hours, or with an unknown value and no failure leave the ticket `unproven` asking for this check, so an inbox error is never called a bug or linked to an inbox master without it. A failed item (unpaid, payments failing, domains not live) makes the verdict billing: `Support/Financial`, never a code bug and never a duplicate link, and the critic checks that call. When every item passes, the ticket continues as a `Bug` or duplicate with the check recorded.
