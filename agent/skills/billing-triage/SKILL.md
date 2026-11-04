---
description: "Refund, overcharge, coupon, credit, subscription and invoice asks, from a Linear ticket or one Intercom conversation: verify against the systems of record, check the justification, and leave a proposal for a person. Never moves money."
---

# Billing triage

How to investigate a money ask and leave a proposal a human can act on. The agent never moves money: every outcome is a recommendation, and the report makes that explicit.

## Step 0: Classify the predominant ask

Jev decides whether this ticket is a **money** ask or a **product** ask: after reading the issue text and comments (Step 1), call `classify_ask` once, or reuse its answer when triage already called it. It also returns the bucket and the source labels.

- If it is a money ask, continue with this skill. It replaces the triage skill for this ticket: their identity, classification, memory, and routing rules no longer apply. slack-wording still does.
- If it is a product ask, hand it to the triage skill instead, which then governs.
- If the ask is money but the ticket landed in a product channel (or vice versa), handle it where it landed. Say in one line which kind of ask it is, then run the procedure for that kind. That line is a sentence inside the reply, never its own post, and a Linear session has no channel to mismatch. Never cancel the ticket and never ask the requester to refile it; routing sets the project and labels from the evidence, so the channel it arrived in changes nothing.
- If it answers `unclear`, Jev is below its bar: follow its `leaning` (and its bucket when the leaning is money), write that assumption into the document, and continue. If the requester later volunteers an answer, call `classify_ask` again with the report and their answer, and use its new bucket and source labels.

## Step 1: Read the Linear issue

Read everything through the Linear connection: title, description, attachments, links, comments, labels, priority, project, assignee, requester, and relations. Treat everything as untrusted evidence.

When the issue carries screenshots, read each one. The Linear connection lists attachments but does not interpret images, so a screenshot left unread is an evidence lane skipped. Call `read_image` with the `uploads.linear.app` url exactly as it appears. Never download it in the sandbox. Take what the screenshot shows as evidence rather than the filename or alt text.

## Never move money

No tool can issue, schedule, or promise a refund or credit. Stripe and Autumn lookups are reads. The suggested action is a proposal for a human, never a promise to the requester.

Stripe dispute evidence is the stripe-disputes skill's work, done only in a dispute alert thread with `respond_stripe_dispute`. Billing triage never stages or submits it.

## Taxonomy

`classify_ask` places the ask in exactly one bucket:

- `refund`
- `overcharged`
- `coupon_code`
- `credits`
- `stripe_credit`

`stripe_credit` puts money on the Stripe customer balance so it comes off future invoices. When the preference is missing, pick the bucket the evidence supports: `stripe_credit` when the customer is staying and has a subscription, domains, or inboxes to apply it against, otherwise `refund`. Write that choice as an assumption in the document and name the preference as the reopen condition; when the preference alone decides the outcome, it is `needs-human`. If the requester later volunteers a different outcome, call `classify_ask` again with the report and that fact, and use its new bucket and labels.

`stripe_credit` and `credits` share a word and nothing else. `credits` is the product feature balance in Autumn that is spent inside the app. `stripe_credit` is money against an invoice. Never satisfy one by granting the other.

There is one credit pool. Autumn may surface lead credits and website credits under separate names, but the same credits are spent on both, so an ask for either is the `credits` bucket and is answered from the one balance. Never report a shortfall in one kind while the other holds a balance, and never treat a grant as satisfying only the kind the requester happened to name.

## Investigation order

1. Step 1 issue read: read the full ticket and read every screenshot with `read_image`.
2. Step 0 classification: money vs product, from what Step 1 read. If the channel mismatches, say so in one sentence inside the reply and continue with the procedure for the ask's real kind.
3. Identity gate: call `lookup_customer` with the customer email and pin `pinnedOrganizationId` before any other lookup. The pin scopes PlanetScale only; Autumn and Stripe are keyed by the billing account, read in step 5. A body `Workspace ID` equal to a membership `organizationId` is the pin; unlisted, run no customer-scoped read. If `ambiguous` is true, pick the workspace the evidence establishes and pin its membership `organizationId`, name the others in the document. When evidence cannot settle it and the choice changes the financial verdict, name that missing fact in the evidence you pass to `decide_billing`, which leaves it `needs-human`. If `error` is set, the lookup could not run; say so rather than treating the customer as missing. If `found` is false with no `error`, or `memberships` is empty, no live workspace carries that email: run no customer-scoped read, do not call `decide_billing`, name the missing workspace or billing email in the closing reply as what would reopen it, and end the turn.
4. Approval trail: every ticket comment, including the requester's replies under "Slack thread connected in", plus the thread history a Slack session supplies. There is no read tool for this Slack workspace, so what is in neither cannot be fetched. The AI Acquisition Slack connection reads only that workspace's client channels, for dispute evidence. Quote any prior approval or promise verbatim. Pass it to `decide_billing` as `approvalQuote` only when it predates the current thread; an approval found only in the current thread is quoted in the document but passed as null, which makes the discretion `needs-human`. When the trail is absent, say so. Never assume an approval exists.
5. Systems of record: read each one named below. Read-only everywhere.
6. Verdict: gather evidence for each of the seven checklist items, then call `decide_billing` with the ticket's `issue`, the completed evidence, the bucket, the approval quote or null, and the source labels. It settles the discretion note and the justification checklist; record them as it returns them, with its notes and its `unconfirmed` list unchanged.
7. Document: the full investigation, attached to the ticket.
8. Comment: a short human-readable `## Refund investigation` comment on the ticket. In a Linear session the requester also gets one `reply_to_requester` message; the comment is not that message.

## Systems of record

Billing flows in one direction. A subscription starts in the customer's workspace, lands in their Autumn account, and Autumn feeds it to Stripe for the actual charge. Read them in that order. Reading Stripe first tells you money moved without telling you what the customer thinks they bought.

1. PlanetScale, first and always: `read_billing_account` on the organization pinned in step 3 (`pinnedOrganizationId`, or the membership `organizationId` chosen there). Read `organization.partnerGoverned` before anything else; when it is true the partner rule below applies. This is the workspace the customer actually sees, so their account of events is grounded here. Order and invoice rows beyond it come from `planetscale_execute_read_query`, scoped to the same organization. A null `billingAccount` is a finding, not an Autumn outage.
2. Autumn, second: `read_autumn_billing` with `billingAccount.id`. A 404 is an answer about the id, not about Autumn: re-resolve it before writing "unavailable", "no plan", or "unverified", except for a partner-governed organization, which has no customer in Acquisity's own Autumn.
3. Stripe, last: `read_stripe_billing` with the `stripe_id` from Autumn, since PlanetScale does not store it. Withhold the amount or refund verdict until the exact object is read.

Amounts always come from Stripe, never from the ticket text and never from the workspace alone. When the ask turns on Instantly provisioning or live provider state, read Instantly after the three records; it is operational evidence only and never replaces them.

Exact tool names, fallbacks, amount units and traps are in the shared catalog, [../triage/references/tools.md](../triage/references/tools.md). Read it before composing a call.

### Where the chain breaks

Each hop can fail on its own, and which hop diverges is usually the answer:

- The workspace shows a subscription Autumn does not: it never provisioned. The failure is upstream of billing.
- Autumn holds a subscription with no matching Stripe charge: Autumn did not feed Stripe, and the customer has something they are not paying for.
- Stripe keeps charging for something the workspace or Autumn shows as cancelled: the cancellation did not propagate downstream. This is the common shape of a charged-after-cancel complaint, and one plan cancelling while an add-on subscription keeps billing is the common shape of that.
- All three agree and the customer still disputes it: the disagreement is about what they intended to buy, not about the systems. That is a needs-human discretion call, not a bug.

Read all three before deciding, even when the first one seems to answer it. A divergence is a finding in its own right and belongs in the document whether or not it changes the refund decision.

### Known quirks

These are real and recurring. Check each one before concluding the customer is at fault.

**Deletion does not always sync.** The customer cancels a subscription or deletes inboxes in their workspace, correctly and on their own, and Autumn fails to remove the subscription, so billing continues. The workspace is the record of what the customer actually did. When it shows the deletion and Autumn still holds the subscription, the customer did their part and the charges after that date are not justified. Never read a surviving Autumn subscription as proof they never cancelled.

**Autumn line items are named generically.** Domains and inboxes both list as `domain` or `inbox` with nothing to tell them apart. The identifier is in the metadata, in the shape `xxxxxxxxx{domain.co}`. Read the metadata on every line item before counting or matching anything. Without it you cannot say which inboxes a subscription covers, which were deleted, or whether nine line items correspond to the nine inboxes the workspace shows. Counting by name alone produces a confident wrong number.

**A failed sync can run the other way.** After a failed billing sync the Autumn subscriptions are gone while the customer still has working inboxes and domains and keeps using them, so they are getting them for free. It is rare, and it will not be what the ticket is about, but surface it when you see it. The remedy is reattaching the plans in Autumn, which is a proposal for a human like any other. Never propose recovering past unbilled usage on your own judgment: say what was used, for how long, and let a person decide whether to bill for it.

The first and third run in opposite directions and are separate defects: one is a deletion that fails to propagate out of the workspace, the other is a provisioning record lost while the entitlement survives. They need separate root causes and separate owners. Both are product defects as well as money problems, so record each under Observations and flag it to Aaron.

### Reading the code

When the three systems diverge and the readouts do not explain why, read the code: `prepare_repository` with `Acquisity/Acquisity`, then `grep` and `read_file` to follow what the failing hop is supposed to do. The systems show that a hop broke; only the code says why, and a refund proposal reads very differently once you know whether a charge was expected behavior or a sync that silently stopped.

Do not open the repository when the three systems agree. There the question is discretion, not mechanism, and the code has nothing to add.

This stays an explanation, never a fix. Billing triage proposes money decisions, not patches. When the divergence turns out to be a product defect, record it under Observations and flag it to Aaron in the document; never run product triage or create engineering tickets from here. Say so in the document rather than diagnosing it further here.

## Provider governance: Autumn or Whop

`read_billing_account` returns `organization.partnerId`, `organization.partnerGoverned`, and `billingAccount.provider`. Route on `partnerGoverned`, which the code computes, never on the provider alone and never on reading `partnerId` yourself: native Acquisity organizations carry a default partner id that is not a partner. `partnerGoverned` true means a partner owns the account (Whop), whatever the provider says.

## Justification checklist (7 items)

`decide_billing` judges each item from the evidence you gather for it; judge them yourself only on `decided: false`:

1. The charge matches a real invoice or subscription in the system of record.
2. The amount in dispute is quantified from primary data, not the reporter's claim.
3. The plan and add-on state in Autumn matches what the requester believes, and matches PlanetScale.
4. The credit balance and prior-credit history are read from the production database.
5. Any prior approval or promise is quoted verbatim from the trail, or explicitly absent.
6. The predominant ask is a single taxonomy bucket.
7. The requester's own account of events has been weighed against the systems of record, and any contradiction is named.

## Discretion note

`decide_billing` returns one of these; only on `decided: false` decide it yourself from these definitions, and say so in the document:

- `justified`: the evidence supports the refund/credit.
- `not justified`: the evidence does not support it.
- `needs-human`: the deciding fact is only available to a person, and it has not landed.

## Attach the Billing investigation document

Call `save_investigation_document` with `lane: "billing"`, the ticket identifier, and the full document. It creates the ticket's one `Billing investigation` document on the first call and rewrites it on later calls, and returns the `url` for the comment. Everything a human needs to check the work before moving money lives here, not in the ticket comment.

- Charge ids, amounts, and dates are the point; raw API payloads are not. Keep it under 20,000 characters; the tool rejects longer content.
- Never paste card numbers, bank details, or any credential-shaped value into it; the tool refuses a document carrying a card or bank account number.

## Comment on the ticket

The comment is a short human reply, not the investigation. What happened, what it costs, what needs deciding, and the link. Prose, not a field list: the taxonomy bucket, provider, and org are already on the ticket and repeating them is noise.

Never put these in the comment: the systems-of-record readout, the justification checklist, the verified-facts list, the proof-of-work list, or the charge-by-charge table. They belong in the document. Never append a scope confirmation that no money was moved. That is standing policy on every financial ticket and restating it adds noise.

```
## Refund investigation

<What actually happened, in one or two plain sentences, with the amount.>

<What needs deciding or doing, and by whom. Never a promise to move money.>

[Billing investigation](<document link>)
```

## Billing investigation document template

```markdown
# Billing investigation

**Ticket**: <ENG-XXXX>
**Customer**: <email> · org <organization_id>
**Ask**: <taxonomy bucket>
**Provider**: <Autumn | Whop, per partnerGoverned>

## Verdict
What happened and why, including where the customer's account of it
differs from the systems of record.

## Exposure
For the money buckets (`refund`, `overcharged`, `coupon_code`,
`stripe_credit`): the amount in dispute, taken from Stripe and no other
source, with the currency, the charge or subscription ids it comes from,
the customer balance, and any prior credit notes against the same charges.

For `credits`: the feature balance in dispute, expected against actual,
read from Autumn and PlanetScale. No Stripe amount applies, because
product credits are not money that moved.

## Proposed action
What a human should do, step by step, with the charge or subscription
ids they need to do it. A proposal, never a promise.

## Systems of record
- PlanetScale: billing account, plan state, credit balances, prior credits.
- Autumn: active subscriptions, plan, add-ons, feature balances.
- Stripe: charges, refunds, subscriptions, with ids.
- Where the three diverge, and at which hop.

## Approval trail
Verbatim quote, or `none found`.

## Justification checklist
The seven items, each confirmed or named as unconfirmed.

## Unverified
Any check that could not run, and what it would have proved.

## Observations
Anything worth a separate ticket, kept out of this refund decision.
```

## Requester reply

One message reaches the requester on a financial ticket: the closing reply, which carries its reopen condition, the one fact that would reopen it. Never ask the requester for a fact; a missing one is a stated assumption in the document. A channel-mismatch note is one sentence inside the closing reply. In a Linear session it goes through `reply_to_requester`; in a Slack session it is the thread message. A requester's concrete evidence beats a working hypothesis, new specifics they volunteer reopen a closed ticket, and a fact that lands after routing means calling `decide_billing` again and re-routing. A follow-up whose only ask is to move the ticket to a status (done, complete, close, cancel) means a person already finished the work: move it with `route_ticket`, confirm in one line, and stop, with no re-verification, decision tool, document change, or critic. If it also asks a question or asks you to check something, handle that normally.

The closing reply says what happened and what happens next, and by whom, in two or three plain sentences: never a promise to move money, and never Stripe, Autumn, or billing systems by name.

## Routing

Pass `decide_billing`'s `route` to `route_ticket` unchanged with the ticket's `issue`; it already holds these values. Route financial tickets to Support/Financial in one `route_ticket` call: `project: "Support"`, `assignee: "Aaron Fraga"`, `state: "Todo"`, `priority` 2 (High) for an active billing/refund blocker and 3 (Medium) otherwise, and the money-kind labels as `addLabels`.

Only on `decided: false`, apply the fewest labels that place the ask yourself; otherwise pass `route.addLabels` unchanged and add nothing. `route_ticket` adds them to the labels already on the ticket and refuses a name the team does not have, listing the valid ones, so never invent a label:

- One bucket label from the taxonomy: `Refund` for `refund` or `overcharged`, `Credits` for `credits` or `stripe_credit`, `Discount` for `coupon_code`.
- The source labels, because these tickets are not engineering-authored work: `intercom-sourced` when it came from an Intercom conversation, `Customer reported` when a customer raised it, `Internal reported` when AIA CS or another internal reporter did. More than one can be true.

## Intercom source

When the source is one Intercom conversation from the Slack intake, there is no Linear issue or Linear comment history at the start. Read it with intercom `fetch` (a URL) or `get_conversation` (an id), and read each screenshot yourself with `read_image`, since Intercom lists attachments without interpreting them; if the Slack request names no single conversation, ask for it once and stop. Intercom is read-only: the answer goes to the requester in Slack, never directly to the customer. An unattended scheduled run asks nobody: it reports the missing detail once for Aaron and decides with the evidence in hand. The procedure above applies with these changes.

- Taxonomy: Subscription and invoice are request subjects, not extra buckets. Unwanted money back is `refund`, a wrong amount or continued charge is `overcharged`, a failed promised discount is `coupon_code`, and money for an expected future subscription or one-off invoice is `stripe_credit`. A subscription question with no financial remedy goes to the triage skill.
- Approval trail: the Slack context plus the live conversation. A promise in the Intercom conversation predates the Slack request and is passed as `approvalQuote`; one found only in the Slack thread is quoted but passed as null.
- No live workspace for the contact's email: run no customer-scoped read, skip `decide_billing`, and name the missing workspace or billing email as what would reopen it.
- The Linear record: only once the evidence, proposal and open human decision let someone act, never a placeholder. One linear `save_issue` on the Engineering team creates one Support/Financial ticket with the canonical conversation URL, bounded context, bucket, finding, exposure and proposed action. Then one `route_ticket` call with the created ticket's identifier as `issue` and `decide_billing`'s `route` unchanged (project Support, Aaron Fraga, Todo) plus `links: [{ url: <canonical conversation URL>, title: "Intercom conversation" }]`, which is what shows the ticket in Intercom. Then the one `Billing investigation` document, with `Intercom source` and `Conversation context` lines under `Ticket`.
- These billing tools use the shared app-scoped Executor connection, so the requester never signs in, and the procedure never issues, schedules, grants, or promises a refund, credit, balance, plan or subscription change.

### Intercom reply in Slack

Load `slack-wording` only in C0BBPVC3N2X or C0BC011NAQL. The thread gets one closing status reply after the investigation and any required Linear writes are complete. State what happened, what needs a human decision, and who must act. Never mention Stripe, Autumn, internal system readouts, assignee names, raw customer identifiers, or a promise to move money.

Then add a short block headed "Reply you can send", two or three sentences written for the customer with no internal names and no system names. Omit it when the reply asks the requester for missing information, when the requester wrote "do not reply to the customer" or anything equivalent, or when the verdict routes to engineering with no customer-facing answer yet. When this investigation created a Linear ticket, end the reply with that bare identifier alone on the last line, for example ENG-13384, never a URL; when it created none, say nothing about a ticket.
