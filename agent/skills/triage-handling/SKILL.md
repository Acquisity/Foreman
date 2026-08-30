---
description: "Handling for a completed Engineering Triage investigation: verdict, unblock, handling path, final Linear state, priority, labels, the one-pass Bug critic review, area routing, masters, the requester reply, and memory bookkeeping. Load after triage-investigate Stage 4 completes the evidence record."
---

# Triage handling

## Stage 5: Decide handling

Purpose: either stop with the missing confirmation explicit when the claim remains unproven, or turn the completed evidence record into one classification, unblock, handling path, final state, priority, and label set.

Inputs: the completed Stage 4 evidence record. Historical memory is analogy only and cannot settle the verdict, duplicate, master, severity, or current blast radius.

### Rehash the claim against the evidence

The lanes are recorded, so the evidence is complete. Say plainly whether the evidence supports the claim, contradicts it, or leaves it unproven. Run Gate 2 (the stop-gate) before any verdict.

When the deciding confirmation is still missing, take the unproven branch and stop before classification. Before stopping, record any safe unblock supported by the completed evidence: the action, owner, current status, and confirmation that it costs the customer neither data nor money, or `None found: <reason>`. Preserve the source ticket's current state, priority, and labels; read the unproven reporting exception in [references/reporting.md](references/reporting.md); attach or update the investigation document with the known facts, missing confirmation, and reopen condition; and give the requester that same reopen condition in the short comment or attended reply. Do not create or attach a master, route engineering work, or record investigation memory.

Otherwise classify as `User Error`, `Platform Limitation`, or `Bug` per the classification rules in `triage-investigate`. A `Bug` verdict requires all three: a named file and function, direct evidence from the current production-data or runtime/provider lanes, and a blast radius counted by a query. Missing any one, it is not a Bug yet: say what is missing and who can supply it. Verdict quality bar: name the cause, not the mechanism.

### Find the unblock

The verdict says what is wrong, not what the customer does tomorrow morning. Answer that separately, even on a `Bug`: a confirmed root cause is not a reason to leave someone stuck waiting for a fix. Ask what gets them working today: a setting they or support can change, a re-run of the failed job, a corrected record, a different path through the product, a manual step on our side. The cause found here says which of these would actually work, which is why this follows the verdict.

When there is one, name it, say who performs it and whether it is already done, and confirm it costs the customer neither data nor money. Never invent a workaround that writes to production or changes billing on your own judgment; propose those and let a person run them. An unblock someone at Acquisity would perform is real only once the evidence shows the procedure exists, works for this case, is safe, and names who is authorized to run it; without all four, record that none was confirmed and what evidence is missing. Naming Support or engineering does not make an unverified action real. When there is none, say so explicitly: a silently absent unblock reads as one nobody looked for.

The unblock never replaces the root cause, never substitutes for the master ticket, and never changes the priority.

### Decide the handling path

Pick one: `Duplicate`, `Resolved by triage`, `User Error`, `Platform Limitation`, `Support/Financial`, `Support/Product follow-up`, `Backlog/low-impact`, `Engineering Todo`. The path classifies the root cause, not the remedy: a ticket can be `Engineering Todo` with the customer unblocked in the same pass, and the two are recorded separately, neither cancelling the other.

### Decide the final Linear state

Set the state that matches the handling path: `Engineering Todo` is `Todo` (the master owns the work; the report stays open under it), `Duplicate` is `Duplicate`, `Backlog/low-impact` is `Backlog`, `Support/Financial` and `Support/Product follow-up` are `Todo` (a person still acts), and `Resolved by triage`, `User Error`, and `Platform Limitation` are `Done`.

### Set Linear priority

Priority comes from impact, never from the reporter's requested priority or how loudly the complaint was phrased. Never leave a ticket at No priority. `route_ticket` takes `priority` as a number: 1 Urgent, 2 High, 3 Medium, 4 Low. Weigh in order:

1. Data loss or security. Any data corruption, loss, or security exposure is automatic `Urgent`, no matter how few accounts are affected.
2. Blast radius, quantified from primary data in Stage 4, not estimated. A core workflow broken for many orgs outweighs one broken for a single org.
3. Frequency. A small failure that hits every send or sync outweighs a severe one that fires rarely.
4. Customer tier. Enterprise or partner exposure breaks ties only, never a reason to inflate a band.
5. Money. An active billing or refund blocker is at least `High`.

Bands:

- `Urgent`: production outage, security or data-loss risk, major revenue or customer-trust incident, or a core workflow blocked for many orgs.
- `High`: multiple orgs blocked on a core workflow, money issue requiring action, repeat production failure, or an enterprise customer blocked.
- `Medium`: a real defect with single-org impact, or non-blocking money follow-up.
- `Low`: cosmetic, edge case, platform limitation, resolved-by-triage, or backlog.

A workaround does not enter the weighting: it makes the customer's day survivable, not the defect smaller. Between two adjacent bands take the higher one and write the rationale where the verdict lives, flagged for a domain expert to review; the weighting above decides the band, and nothing here overrides it. Duplicates inherit the parent's priority and the parent's assignee.

### Label the ticket

Apply the fewest labels that place the ticket, passing them as `addLabels` to `route_ticket` in Stage 6. It adds them to the labels already on the ticket and refuses a name the team does not have, listing the valid ones, so never invent a label:

- One type label from the verdict: `Bug` for a Bug, `Feature Request` for a Platform Limitation the customer wants lifted, and no type label for User Error.
- The source labels, because these tickets are not engineering-authored work: `intercom-sourced` when it came from an Intercom conversation, `Customer reported` when a customer raised it, `Internal reported` when AIA CS or another internal reporter did. More than one can be true.
- One `Root Cause` label when the team has one that matches the cause found in Stage 4.

Every decision above is provisional until the review below has settled the document that records it. Do not apply the state, priority, labels, or project to the ticket yet; Stage 6 does that, and only for a settled document version. Outcomes the review does not cover (`User Error`, `Platform Limitation`, a `Duplicate`, the unproven stop) are applied in Stage 6 without one.

### Review a Bug before routing it

This review runs only when the classification is `Bug` and the handling path is not `Duplicate`. `User Error`, `Platform Limitation`, the unproven stop, and a `Duplicate` go straight to Stage 6: a duplicate routes nothing new to engineering, and the master it attaches to already carries the reviewed root cause.

The critic runs exactly once per ticket. Foreman posts one progress line, delegates once, and adjudicates the result once. A challenge, an evidence gap, or a failed review never triggers a second delegation and never parks the ticket on a person: Foreman settles the findings against the Stage 4 evidence record and continues routing. Only the urgent-human hotlane in the protocol stops a reviewed ticket for a person. Read [references/critic-review.md](references/critic-review.md) and follow it before Stage 6.

Completion: either the unproven branch has made the unblock explicit, preserved the current ticket state, documented the missing confirmation and reopen condition, and stopped before classification, engineering routing, or memory; or one evidence-backed classification and handling path exist, the unblock is explicit, the final Linear state, numeric priority, and complete label union are decided, and, for a `Bug` other than a `Duplicate`, the review has settled the exact document version that records them or the hotlane stopped the review and the ticket is with a person.

## Stage 6: Persist and route

Purpose: leave the durable investigation on the customer ticket, give the requester the short result, and route engineering work without exposing customer data.

Inputs: the Stage 5 decisions and the completed investigation record. For a `Bug` other than a `Duplicate`, the review in Stage 5 settled the document version; a hotlane-stopped review never reaches this stage's writes. Read [references/reporting.md](references/reporting.md) before composing the document or comment.

### Attach the Triage investigation document

For a reviewed `Bug`, the document already exists at the settled version: do not call `save_investigation_document` here; go straight to the post-handoff save below. For every other outcome (`User Error`, `Platform Limitation`, a `Duplicate`, the unproven stop), call `save_investigation_document` with `lane: "triage"`, the ticket identifier, and the full document; it creates or rewrites the ticket's one `Triage investigation` document and returns `documentId`, `updatedAt`, and `url`. Never rewrite a settled document before routing: `engineering-handoff` fails its version check on any earlier edit. After the handoff reads its writes back, save it once more with its final `**Review**` line (`Approved <the updatedAt the critic echoed> at <commit>` or `Adjudicated <the updatedAt Stage 5 read back> at <commit>: <CHALLENGE | INSUFFICIENT_EVIDENCE | review failure>` with its finding clauses) and whatever routing produced. A document created here for an unreviewed outcome is written once with `**Review**: Not required`. Where this skill says to record or say something in the report, it means this document unless it names the comment.

- A handoff, not a transcript: counts and the specific proving rows, not raw dumps, and never credential-shaped columns. Keep it under 20,000 characters; the tool rejects longer content.
- The full document stays on the customer ticket: a Linear document inherits its issue's visibility, so a shared master would expose one customer's identity and rows. The master gets only aggregate evidence: root cause, blast radius figure, and code path, with no organization id, email, or customer rows.

### Comment on the ticket

Write the report comment from the template in [references/reporting.md](references/reporting.md): the root cause in plain language and what happens next, four blocks as a ceiling. The evidence lives in the document, not here. The customer already has their answer from this comment; routing below changes what engineering sees, never what they were told, so never hold the comment back for it.

### Choose the product project from completed evidence

Now, and not before now, determine the owning product project from the confirmed root cause and owning code path established in Stage 4. A memory analogy, symptom, title, repository name, incoming `null`, or incoming `Support` project cannot make this decision. `Support` is a valid evidence-backed final project when support closes the case without engineering, and it records to memory like any other area. Pass the evidence-backed project to the ticket's one `route_ticket` call alongside assignee, labels, priority, and state; its returned `projectId` is what optional memory recording uses.

If the completed evidence genuinely cannot determine ownership, leave the project unset, assign Aaron Fraga as the explicit human-routing fallback, and say in the document which evidence is still missing. Missing or unmapped intake metadata by itself is never that evidence gap and never triggers Aaron routing.

When Aaron explicitly requests read-only validation during an attended manual test, still search memory and complete the evidence work normally. Recommend the evidence-backed project in the result, but apply no Linear mutation and do not record investigation memory. This is an operator instruction for that test, not a runtime authorization mode. Do not require or invent a session marker for it.

### When the ticket is not engineering actionable

`User Error`, `Platform Limitation`, `Resolved by triage`, `Duplicate`, `Backlog/low-impact`, and the `Support/` paths end here: call `route_ticket` once with the Stage 5 state, priority, `addLabels`, and project; a `Duplicate` adds the fields below. The ticket carries the explanation and closes into the Stage 5 state; nothing goes to engineering and no queue should hold a closed report.

A `Duplicate` still inherits. Call `route_ticket` once with `duplicateOf` and `inheritAssigneeFrom` both set to the other ticket, `assignee` set to the area owner from the roster as the fallback, plus the Stage 5 state, priority, and labels, so whoever owns the root cause owns the reports of it. The tool inherits the parent's assignee when it has one and uses the fallback otherwise; say in the document when the parent was unassigned. That fallback is ownership of record, not a work assignment: the ticket still closes into its Stage 5 state in the same pass.

### When the root cause warrants action

The customer ticket never becomes the engineering ticket: a master owns the root cause and this ticket attaches to it. Load `engineering-handoff` and follow it; it hands back the master id, the parent and assignee it set, and the label state. The requester comment above and the Stage 7 reply stay here; the area-routing roster is the owner source `engineering-handoff` uses for an unassigned or new master.

### Area-routing roster

Take the product area from the evidence-backed project selected after the investigation, never from the incoming project, title, symptom, repository name, or memory. Read the roster in [references/roster.md](references/roster.md) and use the emails verbatim; the routing map accepts only allowlisted assignees.

The roster exists on the production ENG team only; SAN sandbox tickets always route to Aaron Fraga. If the area is ambiguous, the project has no lead set, or the roster is unavailable, assign Aaron Fraga and say why in the report. Never route to retired or legacy projects.

Internal notes (identity resolution, routing rationale, customer email addresses, queries) go in the Triage investigation document, never in the ticket comment; a customer-facing comment carries no `## Internal` section.

Completion: the ticket has one durable investigation document, the short requester-facing comment, the accurate final state, and the applicable duplicate, master, parent, assignee, and human-routing updates. Non-engineering outcomes end without engineering routing; actionable root causes return here after exactly one eligible master is reused or created.

## Stage 7: Finish the attended response and memory bookkeeping

Purpose: finish the attended surface cleanly, then attempt optional sanitized memory bookkeeping without reopening the case.

Inputs: the persisted Stage 6 result and the runtime-stamped channel facts.

### Slack-facing reply

Load the slack-wording skill before writing. Give a concrete finding, check whose lane each next step is in and hand the opener only theirs, and keep it to one to three sentences. The final-post rule lives only in `slack-intake.ts`, which stamps it into every intake session boundary; follow that stamp.

### Record the investigation in memory

Last, after the Triage investigation document is attached and the classification is final, call `record_investigation_case`. A reviewed `Bug` is final once its review has settled, approved or adjudicated; a hotlane-stopped review records nothing. A `Duplicate` is final once its master link is saved. Not before: a case from a half-finished investigation is a wrong answer the next ticket inherits.

Send the pattern, not the customer: the claim, root cause, symptoms in the product's own words, identifier-stripped error signatures, the Stage 4 code path and commit, conclusions ruled out, stable evidence handles (Sentry issue ids, Inngest run ids, the document link), counts with the date counted, and links back to the ticket. Never an email address, organization or user id, production row, log, or anything credential-shaped; the tool refuses them and they stay in the document.

The product area comes from the evidence-backed project saved during Stage 6. Re-read the issue after saving it and pass that resulting project id to `record_investigation_case`. Add affected features only where this investigation found evidence they were affected, and dependency keys name the shared systems involved (`instantly`, `webhooks`, `inngest`). One case per ticket, never one per feature.

A failure here changes nothing about the ticket: record it internally when useful and move on; do not retry into a second case, change the comment, or revisit the verdict. Never announce memory reads, writes, or availability in the Slack thread.

If later evidence overturns a recorded conclusion, use `correct_investigation_case`. It supersedes rather than patches, so it takes the whole corrected case: the active case id, the correction reason, and the full payload again, on the same ticket and final project. Recover the case id by searching with the ticket identifier; that project-independent lookup drops the relevance filters and time window and returns the case however old it is. Never record a second case for the same ticket.

A colleague correcting you in the thread or on the ticket is later evidence. When a trusted human contradicts a conclusion you gave, take the correction as the final classification, reply with the corrected guidance, and record it. Look up the ticket's own case first by identifier; `available: false` means memory is down: skip the bookkeeping, the corrected reply still goes out. With an active case, use `correct_investigation_case` with what the colleague said as the correction reason and the thread permalink among the evidence refs. With none, call `record_investigation_case` with the corrected conclusion and put your overturned conclusion in `ruledOut`, so the next search surfaces both the wrong theory and the right answer. Their unblock goes in `resolution`, in the product's own words. Never soften the correction into the record.

When completed evidence cannot identify and save a mapped product project, record no investigation-memory case and use the explicit human-routing fallback from Stage 6. A memory denial, unavailable store, or failed write terminates bookkeeping only; it never changes the verdict, ticket, comment, or Slack reply. An explicitly read-only run also skips this write after recommending a project.

Completion: the attended surface follows the canonical final-post stamp from `slack-intake.ts`, and memory bookkeeping has either succeeded, been skipped by final-project, read-only, or trust policy, or terminated after one non-blocking failure.

## Follow-ups

Answer follow-ups with the gathered evidence, keep internal detail in the document, cap the back-and-forth, and on the third reply give a clear close. A follow-up that corrects your conclusion is not one to close: handle it as a correction under Stage 7.

## Reporting reference

The exact Linear comment shape, good and bad examples, document template, and unproven-branch wording are in [references/reporting.md](references/reporting.md). The master ticket template lives in the `engineering-handoff` skill.
