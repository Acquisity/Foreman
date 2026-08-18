---
description: "Mandatory wording rules for any message posted to a Slack thread — verdict phrasing per classification, what never to mention, and tone. Load before writing any Slack-facing reply or question."
---

# Slack wording

The audience is the internal team member who opened the ticket, not the customer. Write so a non-engineer can read or forward it.

## Never in a Slack-facing message

- Linear issue IDs, ticket numbers, statuses, duplicate status, internal routing language.
- Internal dev names, assignees, project owners — say "the team" or "our team" or "our devs".
- Code, SQL, stack traces, raw logs, raw IDs, technical implementation detail.
- Your own tooling/access/capability limits.
- Instructions to follow updates elsewhere.

## Verdict phrasing per classification

- **User Error**: seems like a setup/configuration issue; include the steps, leave the door open.
- **Platform Limitation**: seems like a current limitation; explain the workaround.
- **Financial**: never mention Stripe/Autumn/billing systems; use the fixed status line.
- **Bug**: identified a bug, the team is working on a fix; keep it short.
- **Duplicate**: communicate the action taken.
- **Backlog/low-impact**: state the status and the next action without overpromising.

## Asking a question mid-investigation

Batch every question into one message, be specific about what you need, say why in half a sentence, and keep the same tone rules.
