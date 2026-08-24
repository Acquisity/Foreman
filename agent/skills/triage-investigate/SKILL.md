---
description: "Full Engineering Triage procedure and policy — the investigation stance, reading the ticket, pinning the customer, duplicates, investigating the claim across code, production data, and runtime evidence, unblocking the customer, classifying, severity weighting and priority bands, labels, the area-routing roster, root-cause masters, and the reply. Load before investigating any triage ticket."
---

# Triage investigate

Goal: find the root cause without spending a developer's time, leave a plain-language explanation and next steps on the ticket, record the full investigation where the next agent can read it, and hand engineering one master ticket per root cause instead of one ticket per customer report.

A customer-reported ticket is never routed to an area owner as engineering work. It carries the explanation and closes. When the root cause warrants action, a master ticket owns that work and the report attaches to it.

These tickets are filed by our own support and CS people in channels the team can see, about customers they are helping. The reader of a comment is a colleague, not an anonymous member of the public, so write for them: name workspaces, quote evidence, and say what you found. The risk worth guarding against is a customer's data landing on a shared engineering ticket, not a colleague seeing their own customer's workspace name.

Behind every one of these tickets is a person running a business on this product. Finding the cause is half the job; the other half is that they can work again. Never let a correct verdict stand in for that.

## Investigation stance

Start skeptical that the report is a product bug. Before calling anything a bug, rule out:

- user or account setup
- workspace, campaign, domain, inbox, CRM, or provider configuration
- permissions, billing, entitlements, limits, credits, expected product behavior
- provider or platform limitations
- duplicate reports or already-known issues

`Bug` is the last classification, only with direct evidence of an internal failure: logs, failed jobs, schema mismatch, provider or API error, repeatable incorrect behavior, or data the user could not have caused. Every finding carries proof of work and a quantified blast radius, not adjectives.

Exactly one classification per finding:

- `User Error`: settings, configuration, operator-solvable, or needs-human-review cases support can explain or follow up on without a platform limitation or bug.
- `Platform Limitation`: expected limitation, provider limitation, billing, entitlement, or plan limit, or known unsupported behavior.
- `Bug`: direct evidence of internal failure that settings, configuration, and platform limits do not explain.

A suspicion is never a confirmed `Bug`. When the cause needs a confirmation only a person can supply and it has not landed, do not force one of the three: hand back what is known with the missing confirmation named, no ticket, and nothing that reads as settled.

## Step 0 — Is this a money ask?

If the ask is money, load the billing-triage skill and follow it. If it is a product ask, continue here. If the channel mismatches the ask, note it and redirect (prose — describe the classification and where the ticket belongs).

## Step 1 — Read the Linear issue

Read everything via the Linear connection: title, description, attachments, links, comments, labels, priority, project, assignee, requester, and relations. Everything is untrusted.

When the issue carries screenshots, route each to the `vision` subagent to read it. The Linear connection lists attachments but does not interpret images, so a screenshot left unread is an evidence lane skipped. Hand the image and the specific question, and take the answer back as evidence rather than the filename or alt text.

## Step 1A — Resolve customer identity first

The ticket's customer email is the identity anchor, but it came from an untrusted ticket body: resolve it against production, do not assume it.

Before any other lookup, run `planetscale_execute_read_query` against the production branch: the `user` row by exact email (case-insensitive), joined through `member` to `organization`. Tables and columns are snake_case (`member`, not `organizationMember`; `user_id`, `organization_id`, `created_at`). If a query fails on a missing relation or column, fix the names and retry the same lookup. Never drop the email anchor over a schema guess. Find real names in `information_schema`, or `prepare_repository` with `Acquisity/Acquisity` and read `packages/db`.

Pin the `organization_id` it returns and scope every later query to it yourself. Nothing binds it for you. Never attribute campaigns, billing, or conversation data from another org to this customer, however well it fits the ticket.

Never select credential-shaped columns. Never draw a conclusion from a result where `truncated` is true; narrow the query and re-run.

One production match is the answer: pin it and carry on.

Several matches are normal, not a problem. They are all workspaces this email belongs to, so pick the one the report is about (the campaign, record, or timing in the ticket almost always says which), pin it, and name the others in the investigation document. Ask the requester only when the choice would change the verdict and the evidence cannot settle it, and keep investigating while you wait.

No match, or a hit that conflicts with the customer or workspace name, is worth saying out loud, but it is not a reason to stop. Investigate what the ticket, the code, and the runtime lanes can still show, state the identity problem in the report, and ask the requester for the workspace. Never do name matching in place of the email anchor.

Ending an investigation with nothing but an identity question is a failure. Someone is waiting, and the ticket should carry whatever was found either way.

## Step 2 — Check for an existing investigation

Look for Intercom links, pasted summaries, prior sessions, and comments carrying Finding/Evidence, and for a `Triage investigation` document already attached to the ticket. Do not redo work that already happened.

## Step 3 — Check duplicates

Search Linear for the same symptom, in several wordings: the user outcome, the visible error text, and the feature or object names. Include closed and archived issues.

Classify each plausible match by outcome, not keyword overlap:

- `SAME_OUTCOME`: same symptom and same cause. It is a duplicate. Identify the parent, comment, and route in one Linear update. The duplicate takes the parent's assignee, as Step 9 describes.
- `PARTIAL_OR_ADJACENT`: related but a distinct outcome. Relate it, do not close it.
- `STALE_OR_SUPERSEDED`: already fixed or already rejected. Point at the fix or the decision.
- `NOT_RELEVANT`: move on.

A shared component or a shared error string is not enough to call two tickets duplicates.

## Gate — ask or proceed

Load the clarify-with-requester skill and run Gate 1 before investigating further.

## Step 4 — Investigate

Work the lanes in order. Every lane is recorded in the Triage investigation document, including the ones that did not apply. A lane with no entry reads as skipped, and a verdict standing on skipped lanes is not a verdict.

Keep the three database surfaces separate:

- PlanetScale is the read-only production and customer-data database. Reach it only through `planetscale_execute_read_query` for current production evidence.
- Investigation memory is Foreman's own private Postgres store of sanitized past-investigation patterns. Reach it only through `search_investigation_memory`, `record_investigation_case`, and `correct_investigation_case`. It holds no customer data and is never current production evidence.
- The `neon__*` connection is for investigating other Neon databases. It is unrelated to investigation memory.

Never locate, inspect, or verify a database in order to use investigation memory. Do not list projects, inspect schemas or roles, count its rows, test SQL, look for credentials, or use `neon__*` on memory's behalf. The three memory tools are the whole interface. If a memory tool answers, its wiring is working. If it returns `available: false` or a write fails, record that only in the investigation document when relevant and carry on. Memory availability never changes the verdict or appears in the Slack reply.

### 4.1 State the claim

Reduce the ticket to one testable sentence: what the user says happened, what they expected instead, when, and on which org, campaign, or record. If the ticket cannot produce that sentence, take the most likely reading, write the assumption into the report, and investigate that. Ask the requester in parallel through Gate 1. Do not sit on the ticket waiting for an answer, and do not guess silently.

### 4.1A Search investigation memory

Only now, with the claim written and the ticket's Linear project read in Step 1, call `search_investigation_memory`. Pass the project id from the ticket, the claim or the visible error text, and the component, provider, and dependency keys you already know. The project is what picks the product area; never pass one inferred from the symptom, the title, or the repository.

A ticket with no project has nothing to search. Record `Unavailable: no Linear project` in the report and carry on with the investigation. Do not invent a project id to satisfy the call, and do not pick the project of a ticket that merely looks similar. Routing already sends an unprojected ticket to Aaron Fraga.

What comes back is past Foreman investigations, sanitized: no customer identity, no production rows. Treat each one as a candidate analogy and nothing more. For every plausible match, write into the report why it matches this claim and what evidence would disconfirm it, then go and check that evidence. A historical `User Error` verdict does not settle this ticket, and a historical root cause is not this ticket's root cause until the current code and current data say so.

The affected counts on a case are the figures from that investigation on the date they were counted. They are never this ticket's blast radius. Count it again in 4.3.

`possibleWiderIncident` means several independent tickets recently landed in this scope. That is a reason to look at current Sentry, Axiom, Inngest, Intercom, or provider evidence for a live incident. It is not an incident, and it does not create a master ticket, set a priority, or declare an outage on its own.

`available: false` is normal and never blocks anything: the store may be unconfigured, unreachable, or the project may not be mapped to a product area. Note it in the investigation document and investigate from scratch, exactly as the rest of this skill describes. Never go looking for the backing database or try another database connection to diagnose it.

Memory can suggest a duplicate candidate. It cannot mark one. Duplicates are still decided by Step 3 against current Linear.

### 4.2 Locate it in the code

`prepare_repository` with `Acquisity/Acquisity`, which refreshes the checkout to the remote HEAD and returns the `worktree` path. Then `grep` and `read_file` under that path to find the code path the claim runs through. Answer what the code is supposed to do before deciding whether it did it.

Record the files and functions, and the commit they were read at: `prepare_repository` does not return one, so take it from `git -C <worktree> rev-parse HEAD`. Without it, a root cause cannot be checked against the code later.

A claim you cannot place in the code is not ready for a Bug verdict.

### 4.3 Check the data

`planetscale_execute_read_query`, scoped to the organization pinned in Step 1A. Read the rows the claim is about and say whether production state matches the claim, contradicts it, or is silent on it. Prefer a bounded `COUNT` or a narrow `SELECT`.

PlanetScale is the production database and the only source of current production truth. Use the root `planetscale_execute_read_query` tool for this lane. Customer data is never in Neon, and neither the `neon__*` connection nor investigation memory substitutes for this lane.

Then count the blast radius, unscoped from this customer: how many distinct orgs and users are in the same state, each counted once however many times they reported it. Always attempt it, and aim for an exact figure from a query, not an estimate and not an adjective. Record the query and the date counted alongside the number, because the count ages.

When an exact count is genuinely not reachable, say so with the tightest bound the data supports and name what blocks the exact figure. A bounded count with its reason is usable; a vague one is not.

### 4.4 Check the runtime

Pick the lanes the symptom points at. Not every lane applies; naming one as not applicable is an answer, guessing is not.

These systems are indexed on different axes, and most of them are not indexed on the customer. Search each on the axis it actually uses: identity (the org id, user id, or email pinned in Step 1A, never the display name), symptom (the behavior in the product's own words, not the customer's), or time (the window the claim names). One search returning nothing closes nothing. Vary the axis before concluding anything, and if the tool wants an identifier you do not have, resolve it first rather than substituting a name.

A lane you could not figure out how to search is `Could not run`, not evidence of absence. Never report a failed search strategy as a clean result.

Exact tool names, per-lane traps, and vendor docs are in [references/tools.md](references/tools.md). Read it before composing a call. Connection tools are called by their qualified name, `<connection>__<tool>`, so Inngest's `get_run_trace` is `inngest__get_run_trace`; the bare names in the lanes below are the server-side names. `planetscale_execute_read_query` is the exception: it is a root tool, called bare, never as `planetscale__planetscale_execute_read_query`. Never invent a tool name from a service's REST API or CLI; an invented call fails in a way that looks like missing data.

- Background work: AI SDR runs, syncs, scrapes, imports, provisioning. Inngest `list_function_runs` for the function named in the code path, then `get_run_trace` on a failing run.
- Errors, crashes, stack traces: Sentry `find_issues` or `search_issues`, then `get_issue_details` for the stacktrace and the first and last seen, to date the failure against the claim. Its natural-language search depends on a provider configured server-side and can be unavailable while the rest works.
- Anything the other lanes do not carry: Axiom `queryDataset` with APL over production logs. Call `listDatasets` and `getDatasetFields` first for real names. APL cannot query metrics; those go through `queryMetrics`.
- Email delivery, bounces, spam placement: Resend `list-emails`, `get-email`, `list-logs`, `list-suppressions`. These names are kebab-case, not snake_case.
- Instantly workspace membership, sending accounts, campaigns, and Unibox delivery state: call the root `list_instantly_subworkspaces` tool first, select an accepted subworkspace by ID when possible, then call `read_instantly_subworkspace`. Pass each returned `nextStartingAfter` value back as `startingAfter` until it is null. This provider lane does not replace PlanetScale as current Acquisity production truth.
- What the user actually did: the Jam link on the ticket when there is one, though usually there is not. PostHog runs through a single `exec` tool taking a named command; resolve the person with `persons` on the email or distinct id from Step 1A, then read `session-recording`. It cannot find anyone by display name. Lucent (`list_issues`, `get_issue`) is indexed by symptom, not by customer, so search it for the behavior (`responses not displaying`) and never for who reported it.
- Deployment or edge failures: Vercel `get_runtime_errors` and `get_runtime_logs` around the reported time.
- The conversation behind the report, and whether others hit it: Intercom, via the link on the ticket or the email pinned in Step 1A. Modem `search_modem` for feedback beyond support threads.

### 4.5 Record the lanes

Fill the Triage investigation document's Evidence and Ruled out sections with every lane: what it returned, or `Not applicable: <reason>`, or `Could not run: <reason>`. A lane that could not run lowers the verdict's confidence and is named in the report.

### 4.6 Rehash the claim against the evidence

The lanes are recorded, so the evidence is complete. Say plainly whether the evidence supports the claim, contradicts it, or leaves it unproven, then classify as `User Error`, `Platform Limitation`, or `Bug` per the investigation stance above. Run Gate 2 (the stop-gate) before any verdict.

A `Bug` verdict requires all three: a named file and function, direct evidence from 4.3 or 4.4, and a blast radius counted by a query. Missing any one of them, it is not a Bug yet. Say what is missing and who can supply it.

Verdict quality bar: name the cause, not the mechanism.

### 4.7 Find the unblock

The verdict says what is wrong. It does not say what the customer does tomorrow morning. Answer that separately, and answer it even when the verdict is `Bug`: a confirmed root cause is not a reason to leave someone stuck waiting for a fix.

Ask what gets them working today. A setting they or support can change, a re-run of the failed job, a corrected record, a different path through the product that avoids the broken one, a manual step on our side. The cause found in 4.6 is what tells you which of these would actually work, which is why this comes after the verdict and not before.

When there is one, name it, say who performs it and whether it has already been done, and confirm it costs the customer neither data nor money. Never invent a workaround that writes to production or changes billing on your own judgment; propose those and let a person run them.

When there is not one, say so explicitly. An unblock section that is silently absent reads as one nobody looked for.

The unblock never replaces the root cause, never substitutes for the master ticket, and never changes the priority. A customer working again today and a defect still tracked at full severity are both true at once.

## Step 5 — Decide the handling path

Pick one: `Duplicate`, `Resolved by triage`, `User Error`, `Platform Limitation`, `Support/Financial`, `Support/Product follow-up`, `Backlog/low-impact`, `Engineering Todo`.

The handling path classifies the root cause, not the remedy. A ticket can be `Engineering Todo` and have had the customer unblocked in the same pass; the two are recorded separately and neither cancels the other.

## Step 5A — Decide the final Linear state

Set the state that matches the handling path.

## Step 6 — Set Linear priority

Priority comes from impact, never from the reporter's requested priority or how loudly the complaint was phrased. Never leave a ticket at No priority. `save_issue` takes `priority` as a number: 1 Urgent, 2 High, 3 Medium, 4 Low.

Weigh these in order:

1. Data loss or security. Any data corruption, loss, or security exposure is automatic `Urgent`, no matter how few accounts are affected.
2. Blast radius, quantified from primary data in 4.3, not estimated. A core workflow broken for many orgs outweighs one broken for a single org.
3. Frequency. A small failure that hits every send or sync outweighs a severe one that fires rarely.
4. Customer tier. Enterprise or partner exposure breaks ties only. Never a reason to inflate a band.
5. Money. An active billing or refund blocker is at least `High`.

Bands:

- `Urgent`: production outage, security or data-loss risk, major revenue or customer-trust incident, or a core workflow blocked for many orgs.
- `High`: multiple orgs blocked on a core workflow, money issue requiring action, repeat production failure, or an enterprise customer blocked.
- `Medium`: a real defect with single-org impact, or non-blocking money follow-up.
- `Low`: cosmetic, edge case, platform limitation, resolved-by-triage, or backlog.

A workaround does not enter the weighting. It makes the customer's day survivable; it does not make the defect smaller. Letting one lower the band would mean the better we get at unblocking people, the less likely the cause is ever fixed.

Between two adjacent bands take the higher one and write the rationale where the verdict lives, flagged for a domain expert to review. This is not licence to inflate: the weighting above decides the band, and nothing here overrides it. Duplicates inherit the parent's priority and the parent's assignee.

## Step 6A — Label the ticket

Read the team's labels with `list_issue_labels` and work only from what comes back. Never invent a label, and never apply a name you assume exists.

Apply the fewest labels that place the ticket:

- One type label from the verdict: `Bug` for a Bug, `Feature Request` for a Platform Limitation the customer wants lifted, and no type label for User Error.
- The source labels, because these tickets are not engineering-authored work: `intercom-sourced` when it came from an Intercom conversation, `Customer reported` when a customer raised it, `Internal reported` when AIA CS or another internal reporter did. More than one can be true.
- One `Root Cause` label when the team has one that matches the cause found in Step 4.

`save_issue` replaces the whole label set: labels already on the ticket and not included in the call are removed. Read the current labels first and pass the union, never just the new ones.

## Step 7 — Attach the Triage investigation document

Create one issue-scoped Linear document per ticket: `save_document` with `issue` set to the ticket and `title: "Triage investigation"`. Passing `issue` is what attaches it, so it appears as a resource on the ticket itself rather than a document filed somewhere else, and anyone reading the ticket can open it in one click. It is the handoff to whoever acts next, and it holds everything the ticket comment leaves out. Where this skill says to record or say something in the report, it means this document, unless it names the comment.

No file upload is involved. `save_document` takes the Markdown directly and an issue is a valid parent, so the attachment route (`prepare_attachment_upload`, a raw PUT, then `create_attachment_from_upload`) is neither needed nor wanted here. Keep the URL it returns: Step 8's comment links it.

- One document per ticket. A later revisit updates it with `patch`, never creates a second.
- Keep it under roughly 20 KB. It is a handoff, not a transcript. Counts and the specific rows that prove the finding, not raw dumps.
- Never paste credential-shaped columns into it.
- The full document stays on the customer ticket. A Linear document inherits the visibility of the issue it hangs from, so attaching this one to a shared master would expose one customer's identity and production rows to everyone who can see that master. Put only the aggregate evidence on the master: the root cause, the blast radius figure, and the code path, with no organization id, email, or customer rows.

## Step 8 — Comment on the ticket

Write the report comment from the template below via the Linear connection. It is the human surface: the root cause in plain language and what happens next. The template's four blocks are a ceiling, not a starting point. The evidence lives in the document, not here.

## Step 9 — Route

The customer already has their answer from Step 8. Nothing here changes what they were told; it changes what engineering sees. Never hold the comment back for this step.

### When the ticket is not engineering actionable

`User Error`, `Platform Limitation`, `Resolved by triage`, `Duplicate`, `Backlog/low-impact`, and the `Support/` paths end here. The ticket carries the explanation and closes into the Step 5A state. Nothing goes to engineering.

Do not route these to an area owner as engineering work. Nobody picks up a closed report, and an area owner reading their queue should not find one there. That is about routing, not about leaving the ticket ownerless.

A `Duplicate` still inherits. When you mark a ticket a duplicate of another, read that other ticket's assignee and set it on the duplicate in the same `save_issue` call that records the duplicate link, so whoever owns the root cause owns the reports of it. Where that ticket has no assignee, fall back to the area-routing roster below and say in the document that the parent was unassigned. That fallback is ownership of record, not a work assignment: the ticket closes into its Step 5A state in the same pass, so it never sits open in anyone's queue.

### When the root cause warrants action

The customer ticket does not become the engineering ticket. A master ticket owns the root cause, and this ticket attaches to it.

1. Search for an existing master no further than 30 days back. For every cause, code-path, provider-failure, and symptom query, call `linear__list_issues` with `team: "8eaf95ab-56ac-4490-8253-f6a96793dc40"` (the Engineering Team id; the name `"Engineering"` silently returns nothing, so pass the id) and `createdAt: "-P30D"`. The code path is the strongest of the four, because two reports running through the same function are almost certainly one bug.

   Do not filter this search by label. A master carries no marker label, so a label filter would match nothing and every report would create another master. A master is recognised by what it is: an ENG issue owning this root cause, usually already parenting customer reports.
2. Apply the 30-day cutoff before comparing or attaching anything. A candidate created exactly 30 days ago remains eligible; one created more than 30 days ago, even by one second, is stale and cannot become this report's parent. Reject an older candidate if it appears through another issue's relations, investigation memory, an unbounded search result, or prior knowledge. Then match the remaining candidates on root cause, never on symptom. Two tickets reporting the same visible failure with different causes need two masters. Two tickets with different symptoms and one cause share a master.
3. If a master already owns the cause: read the master's assignee, then set this ticket's `parentId` to that master and its `assignee` to the master's assignee in the same `save_issue` call (the field is `assignee`, not `assigneeId`), so the child never sits under a master owned by someone else. Where the master has no assignee, fall back to the area-routing roster below and say in the document that the master was unassigned. Then comment the new evidence on the master, re-count the blast radius and update the master's section with the new figure and date, and re-weigh the master's priority. A second independent report is frequency evidence, which is severity weighting item 3. The child count on the master is how anyone sees how many customers hit this without asking, so the parent link matters more than a prose figure that ages.
4. If no eligible master from the last 30 days owns the cause: create one with the master template below, on the ENG team, labelled with the type, priority per Step 6, and assigned to the area owner from the roster below. Then set this ticket's `parentId` to it and its assignee to that same area owner, in one `save_issue` call. An older matching master may be related for history, but never reused as the parent.
5. Do not create a master because a ticket has several acceptance criteria or several steps. One master per root cause.

The recency window exists so masters describe a current cluster of customer reports and preserve real-time blast-radius visibility. It narrows the candidate set only. It never weakens the similarity, evidence, product-area, or duplicate safeguards above.

### Area-routing roster

Take the product area from the ticket's Linear `project`. Never infer it from the title or the symptom. When the project is missing, or maps to no area below, assign Aaron Fraga and record in the report that routing needs a human. Use the emails verbatim: the routing map only accepts assignees on its allowlist, and an unlisted area owner falls back to Aaron Fraga.

- AI SDR: Koppany Kondricz (`koppany.kondricz@acquisity.ai`)
- Cold Email: Anthony Adewale (`anthony.adewale@acquisity.ai`)
- Website Builder: James Keeble (`james.keeble@aiacquisition.com`)
- Core Platform: Anuj Bhatt (`anuj.bhatt@acquisity.ai`), fallback James Keeble
- CRM: Ebubeker Rexha (`ebubeker.rexha@acquisity.ai`)
- Acquisity Agent (AI Consultant): Jil Patel (`jil.patel@acquisity.ai`)
- Anything else: Aaron Fraga (`aaron.fraga@acquisity.ai`)

The roster exists on the production ENG team only. Tickets on the SAN sandbox team always route to Aaron Fraga, whatever the area. If you cannot tell which area an issue belongs to, assign Aaron Fraga and say why the area was ambiguous. If a project has no lead set or the roster is unavailable on a run, assign Aaron Fraga and say in the report that routing needs a human. A guessed owner is worse than an explicit hand-off. Never route to retired or legacy projects.

Internal notes go in the Triage investigation document, never in the ticket comment. Identity resolution, routing rationale, customer email addresses, queries, and anything else engineering needs and the requester does not, belong in the document's Evidence, Code path, and Next steps sections. A customer-facing comment carries no `## Internal` section.

## Step 10 — Slack-facing reply

Load the slack-wording skill before writing. Give a concrete finding, hand the next steps to the opener, check whose lane it is, and keep it to one to three sentences at the floor. The assistant message contains only that requester-facing reply. Never prefix it with an investigation summary or append internal actions, ticket updates, routing, or proof of work.

## Step 11 — Record the investigation in memory

Last, after the Triage investigation document is attached and the classification is final, call `record_investigation_case`. Not before: a case written from a half-finished investigation is a wrong answer that the next ticket inherits.

Send the pattern, not the customer. The claim, the root cause, the symptoms in the product's own words, the error signatures with identifiers stripped, the code path and commit from 4.2, the conclusions ruled out, stable evidence handles (Sentry issue ids, Inngest run ids, the document link), the counts with the date they were counted, and the links back to the ticket. Never an email address, an organization or user id, a production row, a log, or anything credential-shaped. Those live in the document, under the ticket's own visibility, and the tool refuses them.

The product area comes from the ticket's Linear project. Affected features go in only where this investigation found evidence they were affected, and dependency keys name the shared systems involved (`instantly`, `webhooks`, `inngest`). One case per ticket, never one per feature.

A failure here changes nothing about the ticket. Record it internally when useful and move on. Do not retry into a second case, do not change the comment, and do not revisit the verdict. Never announce a memory read or write, promise to save something to memory, or mention memory availability in the Slack thread.

If later evidence overturns a conclusion you already recorded, use `correct_investigation_case`. It supersedes rather than patches, so it takes the whole corrected case, not just the change: the active case id, the correction reason, and the full payload again, on the same ticket and project. The case id comes from the write that recorded it. In a later session you will not have it, so search with the ticket identifier to get it back. A plain search is ranked, capped, and bounded by a time window, so a ticket's own case can fall outside it; adding the ticket identifier drops the relevance filters and the time window and returns the case however old it is. Still pass the project id, which the call always requires. The old conclusion stays readable and stops being used. Never record a second case for the same ticket.

## Follow-ups

Answer follow-ups with the gathered evidence, keep the internal detail in the document, cap the back-and-forth, and on the third reply give a clear close.

## Linear report template

Prose, not a field list. The classification, priority, and handling path are already set on the ticket as state, priority, and labels; repeating them in the comment is noise.

```markdown
## Triage investigation

<What gets them working now, and who does it. `None found: <reason>`
when there is nothing that would.>

<The root cause in one or two plain sentences, in the customer's terms.>

<How many workspaces are affected, or "only yours" when it is one.>

[Triage investigation](<document link>)
```

The unblock leads. Someone stuck cares about working again before they care about the cause. Never silently drop it: a missing unblock line and one nobody looked for read the same. The engineering ticket is not named here: once Step 9 makes this report a child, Linear shows the parent on the issue itself.

Those blocks are the whole comment. Each is at most two short paragraphs, and no heading appears beyond the title. These never appear in a comment, whatever the investigation turned up:

- per-month or per-week breakdowns
- corrections to the figures the reporter gave
- cohort-wide counts beyond the one line saying how many workspaces are affected
- code paths, files, functions, commits
- queries and their raw output
- identity resolution: how the email resolved, which organization ids matched, which was picked
- routing rationale: which master was chosen, which area owner it went to, why
- a `## Internal` section of any kind

All of it goes in the Triage investigation document that the last line links. The reader of the comment should reach the sentence telling them what to do without scrolling.

### Good comment

Two short paragraphs, the tickets linked inline, the document attached below.

```markdown
Duplicate of [ENG-12820](<link>) Michael Simon - AI SDR not answering emails: same
customer and same ask, filed 17 Aug. That ticket now carries the full investigation
and is attached to the active incident [ENG-12983](<link>) Restore and bulletproof
Instantly webhook reply delivery, the 13 August Instantly webhook outage.

Bottom line: Michael's workspace was hit by the 13 Aug Instantly webhook outage.
Inbound replies stopped arriving 13-16 Aug and 8 were lost on 18 Aug, so the AI SDR
had nothing to answer. The webhook is restored and the AI SDR is answering again
(5 replies today, 10 yesterday). Missed replies are being recovered by
[ENG-12985](<link>) Restore the affected webhooks and recover missed replies. Asking
the requester to confirm which specific emails Michael expected answered, to catch
anything still broken today.

[Triage investigation](<link>)
```

This one is a duplicate, so the pointer to the ticket that now owns it leads and the unblock rides in the bottom line. On a ticket that is not a duplicate, the unblock is the first block.

### Bad comment

Same shape of ticket, seven-plus paragraphs, everything the document was for pasted into the comment.

```markdown
## Summary
...

## What we found
Reply counts by month, Jun through Aug, with the figure in the ticket corrected
from 40 to 12.

## Blast radius
The whole cohort, org by org, with the query.

## Open question
...

## Internal
Resolved identity: user_id, organization_id, the customer's email addresses, and
which of the three matching workspaces was picked and why. Routed to the AI SDR
area owner because the project is AI SDR.
```

Nothing in the bad comment is wrong. It is all in the wrong place. The headings, the month-by-month breakdown, the corrected figure, the cohort count, the identity resolution, and the `## Internal` block all belong in the document, and the one sentence the reader needed is buried under them.

## Triage investigation document template

```markdown
# Triage investigation

**Ticket**: <ENG-XXXX>
**Classification**: <User Error | Platform Limitation | Bug>
**Organization**: <organization_id> (<org name>)

## Claim
The one testable sentence from 4.1.

## Root cause
The cause, not the mechanism.

## Evidence
Every lane from 4.2 through 4.4: the queries run and what they returned,
or `Not applicable: <reason>`, or `Could not run: <reason>`.

## Prior cases
Each match from 4.1A: the ticket it came from, why it looked like this
claim, and what current evidence confirmed or disconfirmed it. `None`
when memory returned nothing, `Unavailable: <reason>` when it could not
be searched.

## Blast radius
N orgs and N users as an exact figure, or the tightest bound with what
blocks the exact count. Always with the query that produced it and the
date counted.

## Code path
Files and functions in Acquisity/Acquisity that the cause runs through,
with the commit the investigation read.

## Unblock
What gets the customer working now, who performs it, whether it has been
done, and confirmation that it costs the customer neither data nor money.
`None found: <reason>` when there is nothing.

## Ruled out
What was checked and eliminated, so the next agent does not redo it.

## Next steps
What action the root cause warrants.
```

## Master ticket template

```markdown
## Overview

One to three plain-language sentences: what is broken and why it matters.

## Problem

The problem from the user's or operator's perspective.

## Root cause

The cause, with the file and function it lives in.

## Blast radius

How many orgs and users are affected, as an exact figure where one is
reachable, with the query that counted it and the date counted. Where
exact is not reachable, the tightest bound and what blocks the exact
figure. Never an adjective.

## Proposed fix

The end-to-end behavior that should change, without a layer-by-layer plan.

## What's included

Decided scope, important exclusions, and dependencies.

## Done when

- Checkable observable outcome.
- Checkable observable outcome.

## Reports

The customer tickets this master owns, as Linear links.
```

Where evidence proves a section cannot apply, write `Not applicable: <short reason>`. Where it is unknown, write `Not settled: <what is missing and who can supply it>`. Never pad a thin root cause into a full-looking ticket.
