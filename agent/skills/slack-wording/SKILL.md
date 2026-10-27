---
description: "Wording rules only for acquisity-feedback (C0BBPVC3N2X) and acquisity-refunds-request (C0BC011NAQL). Load before replies in those two channels. Does not apply to other Slack channels."
---

# Slack wording

## Channel scope

Apply this skill only when the delivered Slack channel ID is C0BBPVC3N2X (acquisity-feedback) or C0BC011NAQL (acquisity-refunds-request), and to every `reply_to_requester` message, which posts into those channels from a Linear session. All restrictions and verdict rules below are limited to those messages.

In every other channel, none of this skill's wording restrictions apply, even if another workflow told you to load it. Answer the request normally, including engineering ticket links, identifiers, assignees, or technical details when relevant. A request for an existing ticket link needs the link, not a new investigation. Do not infer this scope from the topic, an intake-only marker, or a channel name mentioned in message text.

Within the two scoped channels, the audience is the internal team member who opened the ticket, not the customer. Write so a non-engineer can read or forward it. Internal engineering reports that exist to route work, such as the daily SLA report, carry their own format.

The Slack channel boundary injects the canonical final-post rule into every Slack session; in a Linear session the `reply_to_requester` one-message rule does that job. Follow the one that applies for the final message; do not restate or replace it here.

## Never in a Slack-facing message

- Linear issue IDs, ticket numbers, statuses, duplicate status, internal routing language. The one exception: when the requester explicitly asks for the ticket link, give that link.
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
- **Financial**: the phrasing for every money ask, which carries a bucket and a discretion note, never a triage classification. Say what happened and what happens next and by whom, in plain words, never a promise to move money; never mention Stripe/Autumn/billing systems.
- **Bug**: identified a bug and passed it to the team; keep it short. Say the team is already working on this, or working on a fix, only when a matching engineering issue covering the same problem is In Progress or current explicit evidence shows active engineering work; this holds when the requester's own ticket is new or a Duplicate. Finding a duplicate, or creating or routing a Todo ticket, does not show active work. Never imply a delivery date or a deployed fix.
- **Duplicate**: say it is already reported and with the team.
- **Backlog/low-impact**: say it is logged as low impact, without promising a next action.

## Automatic reporter updates

The scheduled reporter-updates job, not a session turn, posts these messages: received, fixed (a bug), live (a feature, with how to use it), done (a change made without code), not a bug, duplicate (then fixed or live when the original ships) and closed. The fixed lines and fallbacks live in `agent/lib/reporter-updates/copy.ts`; the short phrases inside them come from the `writer` slot (`writer.ts`). Change wording there, keep any text an earlier version posted in `PAST_TEXTS` so those messages are still recognised, and keep these rules:

- About 40 words at most; a message that runs over drops its optional part or uses its fallback line.
- Never name an owner or developer. Reporters don't know them. A written phrase that contains any owner-map person's name falls back to the fixed line.
- When something new ships, say how to use it and where to find it on screen, naming the button, page or menu.
- Never say a change was made unless one was. A Done ticket with no linked change posts "Done" only when a staff member's closing comment describes the change; otherwise nothing is posted.
- No filler such as "Nothing for you to do", "Good news" or "as soon as there's news". A test checks every message.
- Never use file paths, PR numbers, CI, ticket states or IDs, model names, "root cause", "deploy", "merge" or raw error codes.
- A fixed or live message is sent only after the change is live for users, never when the ticket merely moves to Done.
