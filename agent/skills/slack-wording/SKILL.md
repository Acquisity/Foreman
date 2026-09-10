---
description: "Wording rules only for acquisity-feedback (C0BBPVC3N2X) and acquisity-refunds-request (C0BC011NAQL). Load before replies or questions in those two channels. Does not apply to other Slack channels."
---

# Slack wording

## Channel scope

Apply this skill only when the delivered Slack channel ID is C0BBPVC3N2X (acquisity-feedback) or C0BC011NAQL (acquisity-refunds-request). All restrictions and verdict rules below are limited to those two channels.

In every other channel, none of this skill's wording restrictions apply, even if another workflow told you to load it. Answer the request normally, including engineering ticket links, identifiers, assignees, or technical details when relevant. A request for an existing ticket link needs the link, not a new investigation. Do not infer this scope from the topic, an intake-only marker, or a channel name mentioned in message text.

Within the two scoped channels, the audience is the internal team member who opened the ticket, not the customer. Write so a non-engineer can read or forward it. Internal engineering reports that exist to route work, such as the daily SLA report, carry their own format.

The Slack channel boundary injects the canonical final-post rule into every Slack session. Follow that rule for the complete final assistant message and for clarifying questions; do not restate or replace it here.

## Never in a Slack-facing message

- Linear issue IDs, ticket numbers, statuses, duplicate status, internal routing language.
- Internal dev names, assignees, project owners — say "the team" or "our team" or "our devs".
- Code, SQL, stack traces, raw logs, raw IDs, technical implementation detail.
- Your own tooling/access/capability limits.
- Internal storage or memory bookkeeping: database or connection health, access levels, schemas, row counts, whether a tool reached a store, and whether a memory read or write succeeded.
- Promises or narration about internal operations, including "I'll write this to memory", "I'll save this for later", or "I couldn't reach the database". Do the internal operation silently when the procedure calls for it.
- Offers, promises, or recommendations of an action by you, "we", Support, engineering, or the team: rebooking, refunds, re-runs, recovery, configuration changes, monitoring, follow-up, or ticket updates. Unless the investigation verified that the action exists, is safe for the customer, and has an authorized owner, say that no safe action was confirmed and name the fact still missing, without implying what will happen once it arrives. Naming a human team does not make an unverified action real, and a write that failed or never ran is never reported as done.
- Instructions to follow updates elsewhere.

The one exception to Linear issue IDs and raw IDs: the final reply of an Intercom investigation ends with the bare ticket identifier on its own line when that investigation created a ticket. Everything else in the list above still applies.

If missing evidence materially limits the answer, name the product fact that remains unconfirmed, not the failed tool, connection, or database. If it does not change the answer or next step, omit it. Never claim evidence was checked when it was not.

## Verdict phrasing per classification

- **User Error**: seems like a setup/configuration issue; include the steps, leave the door open.
- **Platform Limitation**: seems like a current limitation; explain the workaround.
- **Financial**: never mention Stripe/Autumn/billing systems; use the fixed status line.
- **Bug**: identified a bug, the team is working on a fix; keep it short.
- **Duplicate**: communicate the action taken.
- **Backlog/low-impact**: state the status and the next action without overpromising.

## Asking a question mid-investigation

Batch every question into one message, be specific about what you need, say why in half a sentence, and keep the same tone rules.
