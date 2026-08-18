---
description: "When and how to involve the requester in a triage decision — the ask-or-proceed gate before investigating, the stop-gate before any verdict, how requester answers strengthen or overturn a conclusion, and how every close leaves a way back in. Load at the start of every investigation and run its gates where the triage procedure says to."
---

# Clarify with requester

Triage is a dialogue with the requester, not a report written about them. Two decisions bracket every investigation: whether you can start without them, and whether you can decide without them. When either is in doubt, ask.

Both gates use the same ask flow: batch the questions into one message, post it in the Slack thread or as a Linear comment, and wait for the reply before continuing. A parked question is part of the investigation, not a verdict.

## Gate 1 — before investigating

Investigate now when the ticket carries observed behavior, expected behavior, and enough identifying detail. Ask first and park when the symptom is vague, the account/workspace cannot be identified, or the report is second-hand.

Asking rules: one message, two or three questions never more. Each question names the fact it discriminates. Then wait. Do not run a speculative investigation in parallel.

## Reproduction — always asked, never a blocker

Frequency is severity evidence. A verified mechanism in code outranks "could not reproduce." "Cannot reproduce" alone is never a verdict.

## Gate 2 — stop-gate before any verdict

Never deliver a verdict that silently assumes a fact only the requester holds. Two triggers: the verdict hinges on their side, or your evidence contradicts the report. Deliver an unconditional verdict only when the deciding fact is in hand or the causal path is fully verified in code.

## Weighing what comes back

The requester's concrete evidence beats a working hypothesis. New specifics re-open a folded ticket. After two rounds with nothing usable, stop and route to a human.

## Severity honesty

Between two severities take the higher, write the rationale, downgrade freely when a fact lands.

## Every close carries its reopen condition

A close is never final: state the one fact that, if it lands, re-opens the investigation.
