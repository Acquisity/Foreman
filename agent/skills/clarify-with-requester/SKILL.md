---
description: "When and how to involve the requester in a triage decision — the ask-or-proceed gate before investigating, the stop-gate before any verdict, how requester answers strengthen or overturn a conclusion, and how every close leaves a way back in. Load at the start of every investigation and run its gates where the triage procedure says to."
---

# Clarify with requester

Triage is a dialogue with the requester, not a report written about them. Two decisions bracket every investigation: whether you can start without them, and whether you can decide without them. When either is in doubt, ask.

Both gates use the same ask flow: batch the questions into one message. In a Slack session post it in the thread. In a Linear session it is your one `reply_to_requester` message, never a Linear comment, sent at Gate 1 when a customer-specific check cannot run without the missing fact, or at Gate 2 when the verdict needs it; otherwise record the open question in the investigation document and answer. After asking, keep checking the evidence that does not depend on the answer. Withhold only what depends on it: the verdict, routing, and the closing reply. An open question is not a verdict.

## Gate 1 — before investigating

Investigate now when the ticket carries observed behavior, expected behavior, and enough identifying detail. Ask when the symptom is vague, the account/workspace cannot be identified, or the report is second-hand, then continue with evidence that does not depend on the answer. Unresolved identity blocks customer-specific lookups, not safe code or runtime checks.

Asking rules: one message, two or three questions never more, asking only for facts the evidence has not already settled. Each question names the fact it discriminates. State any working assumption and test it against available evidence; never present it as confirmed or guess a customer scope.

## Reproduction — always asked, never a blocker

Frequency is severity evidence. A verified mechanism in code outranks "could not reproduce." "Cannot reproduce" alone is never a verdict.

## Gate 2 — stop-gate before any verdict

Never deliver a verdict that silently assumes a fact only the requester holds. Two triggers: the verdict hinges on their side, or your evidence contradicts the report. Deliver an unconditional verdict only when the deciding fact is in hand or the causal path is fully verified in code.

## Weighing what comes back

The requester's concrete evidence beats a working hypothesis. New specifics re-open a folded ticket. This is the one cap on asking, and triage and billing both use it: after two rounds with nothing usable, stop asking and close with the best answer the evidence supports and its reopen condition.

## Severity honesty

Priority and routing belong to the decision tool (`decide_triage`, or `decide_billing` for a money ask). A fact that lands before routing means calling it again; after routing, a changed conclusion re-runs it and re-routes.

## Every close carries its reopen condition

A close is never final: state the one fact that, if it lands, re-opens the investigation.
