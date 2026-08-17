---
description: "Refund, overcharge, coupon, lead-credit, and website-credit investigation — classify the predominant ask, verify against the systems of record, ask the justification questions before any verdict, and leave a proposal on Linear. Never moves money. Load for any ticket about refunds, credits, coupons, charges, subscriptions, invoices, or plans."
---

# Billing triage

How to investigate a money ask and leave a proposal a human can act on. The agent never moves money: every outcome is a recommendation, and the report makes that explicit.

## Step 0 — Classify the predominant ask

Decide whether this ticket is a **money** ask or a **product** ask.

- If it is a money ask, continue with this skill.
- If it is a product ask, hand it to the product triage procedure instead.
- If the ask is money but the ticket landed in a product channel (or vice versa), note the mismatch and redirect: describe the classification and where the ticket belongs, and route it accordingly. There is no redirect tool — the redirect is the classification note plus the routing.
- If you cannot place the ask, ask one batched question to place it before doing anything else.

## Never move money

No tool can issue, schedule, or promise a refund or credit. Stripe and Autumn lookups are reads. The suggested action is a proposal for a human, never a promise to the requester.

## Taxonomy

Place the ask in exactly one bucket:

- `refund`
- `overcharged`
- `coupon_code`
- `lead_credits`
- `website_credits`

## Investigation order

1. **Step 0 classification** — money vs product, redirect if the channel mismatches.
2. **Identity gate** — resolve the org by email via the production database, pin `organization_id`. If the email maps to more than one org or the identity is ambiguous, stop and ask before any other lookup.
3. **Approval trail** — read the ticket comments via the Linear connection and the Slack thread, and quote any prior approval or promise verbatim. Never assume an approval exists.
4. **Systems of record** — Stripe for charges, refunds, and subscriptions; Autumn for plan, add-ons, and balances; the production database for org → billing account → credit balances → prior credits. Read-only everywhere.
5. **Clarifying questions** — batched, before any verdict, capped at three rounds.
6. **Verdict** — classification, justification checklist, discretion note, and the report.

## Provider governance — Autumn vs Whop

Check `organization.partner_id` before routing on the billing provider. Never route on `provider='whop'` alone: the partner field is the source of truth for which billing system owns the account.

## Clarifying questions per type

- **refund**: what was charged, when, and what the requester expected instead; whether the charge was for a renewal they did not intend.
- **overcharged**: the amount charged vs the amount expected, and which plan/add-on they believe they are on.
- **coupon_code**: the code, where it was entered, and the error or silence they saw.
- **lead_credits**: how many credits they believe they had, how many were consumed, and what they expected the consumption to be.
- **website_credits**: the balance they expected vs the balance shown, and the action that should have credited or debited them.

Each question names the fact it discriminates. Batch them into one message and wait.

## Justification checklist (7 items)

Before any verdict, confirm each:

1. The charge matches a real invoice or subscription in the system of record.
2. The amount in dispute is quantified from primary data, not the reporter's claim.
3. The plan/add-on state in Autumn matches what the requester believes.
4. The credit balance and prior-credit history are read from the production database.
5. Any prior approval or promise is quoted verbatim from the trail, or explicitly absent.
6. The predominant ask is a single taxonomy bucket.
7. The requester's own account of events has been weighed against the systems of record, and any contradiction is named.

## Discretion note

Every verdict carries one of:

- **justified** — the evidence supports the refund/credit.
- **not justified** — the evidence does not support it.
- **needs-human** — the deciding fact is only available to a person, and it has not landed.

## Linear report template

Write the proposal as a Linear comment via the Linear connection:

```
## Refund investigation

**Ask**: <taxonomy bucket>
**Org**: <organization_id>
**Amount in dispute**: <quantified, or "not quantified">
**Systems of record**:
- Stripe: <charges/refunds/subscriptions found>
- Autumn: <plan/add-ons/balances found>
- Prod DB: <billing account, credit balances, prior credits>

**Approval trail**: <verbatim quote, or "none found">

**Justification checklist**:
- [ ] / [x] <item> ...

**Discretion note**: justified / not justified / needs-human

**Suggested action**: <proposal for a human — never a promise to move money>
```

## Slack reply

At most three things on a financial ticket:

1. The batched clarifying questions, if any.
2. The redirect message, if the channel mismatched.
3. One closing status reply, using the fixed status line.

The status line is fixed; do not use a free-form reply on financial tickets. Never mention Stripe, Autumn, or billing systems by name in a Slack-facing message.

## Routing

Route financial tickets to Support/Financial, project Support, assign Aaron Fraga, and move to Todo. Priority High for an active billing/refund blocker, Medium otherwise.
