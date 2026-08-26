---
description: "Mandatory wording rules for any message posted to a Slack thread — verdict phrasing per classification, what never to mention, and tone. Load before writing any Slack-facing reply or question."
---

# Slack wording

The audience is the internal team member who opened the ticket, not the customer. Write so a non-engineer can read or forward it.

Scope: every conversational Slack reply or question, including ticket threads, where the reader may forward the message onward. Internal engineering reports that exist to route work, such as the daily SLA report, are not in scope and carry their own format; they need ticket links, assignee tags, and root cause, all of which the rules below forbid.

The final post in the Slack thread is a single-audience message. It contains only the forwardable requester reply. Never combine it with an internal investigation summary, a Linear update report, proof of work, or a preamble such as `Here is my investigation summary and Slack reply`. Normal assistant progress updates may be conversational, but they do not change this final-post boundary.

## Never in a Slack-facing message

- Linear issue IDs, ticket numbers, statuses, duplicate status, internal routing language.
- Internal dev names, assignees, project owners — say "the team" or "our team" or "our devs".
- Code, SQL, stack traces, raw logs, raw IDs, technical implementation detail.
- Your own tooling/access/capability limits.
- Internal storage or memory bookkeeping: database or connection health, access levels, schemas, row counts, whether a tool reached a store, and whether a memory read or write succeeded.
- Promises or narration about internal operations, including "I'll write this to memory", "I'll save this for later", or "I couldn't reach the database". Do the internal operation silently when the procedure calls for it.
- Instructions to follow updates elsewhere.

If missing evidence materially limits the answer, name the product fact that remains unconfirmed, not the failed tool, connection, or database. If it does not change the answer or next step, omit it. Never claim evidence was checked when it was not.

## Action statements

Every sentence that promises, offers, recommends, or reports an operation is checked at the Slack boundary against evidence recorded this turn. That covers actions attributed to you, "we", Support, engineering, the team, or anyone else. A sentence that fails the check never posts; the thread gets a fixed fallback instead, so write only sentences you can back.

An action sentence is in exactly one state:

- Completed: a tool in this turn performed it and returned successfully. Before writing "The ticket was updated", call `attest_action_statement` with `state: "completed"`, the exact sentence, and the tool that did it. A failed, denied, or unattempted write is never completed; say that no update was made.
- Verified available, not performed: the investigation verified the procedure, that it works for this case, its safety for the customer's data, money, configuration, and workflow, and who is authorized to perform it. Call `attest_action_statement` with `state: "available"` and all of that evidence. Name that owner in the sentence and phrase it as their option, never as a promise, never as "we" or "I".
- None confirmed: any of those facts is missing. Do not offer, recommend, or volunteer the action, and do not hand it to Support or engineering instead. Write that no safe action was confirmed and name only the evidence still missing, without saying what would happen once it arrives. For example: "No safe rebooking path was confirmed during this investigation. Whether the affected appointments can be recovered remains unresolved."

Findings, product steps the customer can take in the product, and plain statements that nothing was done carry no action and need no attestation. Never invent a capability for Foreman, Support, or engineering because it sounds reasonable, and never imply that sharing identifiers guarantees remediation.

## Verdict phrasing per classification

- **User Error**: seems like a setup/configuration issue; include the steps, leave the door open.
- **Platform Limitation**: seems like a current limitation; explain the workaround.
- **Financial**: never mention Stripe/Autumn/billing systems; use the fixed status line.
- **Bug**: identified a bug, the team is working on a fix; keep it short.
- **Duplicate**: communicate the action taken.
- **Backlog/low-impact**: state the status and the next action without overpromising.

## Asking a question mid-investigation

Batch every question into one message, be specific about what you need, say why in half a sentence, and keep the same tone rules.
