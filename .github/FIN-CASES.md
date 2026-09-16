# Fin case filing and status (ENG-13769)

A customer asks Fin a question, Foreman investigates in the scoped Fin lane, and the investigation either files one Linear ticket or files nothing. The Intercom conversation ID is already written into the Linear issue description and its link attachment, so it is the idempotency key, and Linear is the only source of truth for whether a ticket exists for a conversation. Nothing else records the association, so nothing else can disagree with it.

## Filing

`fileFinCase` in `agent/lib/fin-case-filing.ts` takes the model's structured decision: `not-needed` with a reason, or `file` with title, summary, customerSummary, project, assignee, classification and priority. `not-needed` returns immediately and makes zero provider calls.

`file` searches Linear with `list_issues`, querying the Intercom conversation ID scoped to the Engineering Team. Zero matches creates the issue once. Exactly one match returns `already-tracked` and creates nothing. More than one match returns `failed` instead of guessing which ticket belongs to this conversation. A paginated result returns `failed`, because a partial page cannot establish a match count.

Filing costs at most three Linear calls: list, save, get. There is exactly one `save_issue` call site and it is never retried.

After creating or matching, the issue is read back once and verified before any success claim: the description and the link attachment each carry exactly one Intercom conversation ID, it is this conversation's, and the issue URL matches its own identifier. A newly created issue is additionally checked against the decision for project, assignee and priority, with every label the decision implies present. A matched issue is not, because a ticket filed earlier has usually been triaged since and a moved project, owner or priority is healthy rather than a failed write. Any mismatch returns `failed`.

The investigation report lives in the issue description, written atomically at creation. There is no separate Triage investigation document, and no `save_document` or `get_document` call.

## Outcomes and persistence

The four outcomes are `newly-created`, `already-tracked`, `not-needed` and `failed`. The outcome is saved inside the existing `outcome` jsonb on the existing `fin_investigation_runs` row: no new table and no new column.

The customer-facing HTTP payload carries the outcome and its message, never the ENG identifier. The internal Slack receipt keeps the identifier.

## Status follow-up

`read_fin_case_status` is a no-argument tool offered in the Fin lane only. It runs the same conversation-ID search against the session's immutable scope and returns one customer-safe sentence for the Linear status, in at most two Linear calls. It returns neither the identifier nor a Linear URL. `completed` means the ticket is marked done, which alone does not confirm deployment or resolution in the customer's workspace.

There is no HTTP route for status. A status question in the chat is an ordinary turn, and `agent/channels/fin.ts` keeps exactly its two existing routes.

## Deliberately not built

PR #138 built each of the following and they were cut. Do not re-add them without new evidence.

- A `fin_cases` table with migrations `0008` and `0009`, including a partial unique index over unresolved creations. Linear already holds the association, and a second store can disagree with it, which it did in review.
- Two-phase creation, document reservations, and a reconciliation pass that re-ran the whole filing attempt on failure. Search before create covers the same ground, and a lost race costs one duplicate ticket that a human closes in seconds.
- A `POST /internal/fin/case` status endpoint with its own bearer identity, triple re-verification and suppression handling. A status question in the chat is an ordinary turn.
- Cross-chat status lookup, `case_reference`, `previous_status`, an `unchanged` response, and the multi-report clarification flow that returned bounded customer subjects. Deferred until a real customer asks from a fresh chat.

ENG-13769's original acceptance asked for fresh-chat follow-ups and multi-case clarification. This slice deliberately ships same-conversation status only.
