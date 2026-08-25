# Triage reporting

Use these exact output constraints and templates during Stage 6 of the triage-investigate workflow.

## Linear report template

Prose, not a field list. The classification, priority, and handling path are already set on the ticket as state, priority, and labels; repeating them in the comment is noise.

```markdown
## Triage investigation

<What gets them working now, and who does it. `None found: <reason>` when there is nothing that would.>

<The root cause in one or two plain sentences, in the customer's terms.>

<How many workspaces are affected, or "only yours" when it is one.>

[Triage investigation](<document link>)
```

The unblock leads. Someone stuck cares about working again before they care about the cause. Never silently drop it: a missing unblock line and one nobody looked for read the same. The engineering ticket is not named here: once Stage 6 makes this report a child, Linear shows the parent on the issue itself.

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
## Triage investigation

Duplicate of [ENG-12820](<link>) Michael Simon - AI SDR not answering emails: same customer and same ask, filed 17 Aug. That ticket now carries the full investigation and is attached to the active incident [ENG-12983](<link>) Restore and bulletproof Instantly webhook reply delivery, the 13 August Instantly webhook outage.

Bottom line: Michael's workspace was hit by the 13 Aug Instantly webhook outage. Inbound replies stopped arriving 13-16 Aug and 8 were lost on 18 Aug, so the AI SDR had nothing to answer. The webhook is restored and the AI SDR is answering again (5 replies today, 10 yesterday). Missed replies are being recovered by [ENG-12985](<link>) Restore the affected webhooks and recover missed replies. Asking the requester to confirm which specific emails Michael expected answered, to catch anything still broken today.

[Triage investigation](<link>)
```

This one is a duplicate, so the pointer to the ticket that now owns it leads and the unblock rides in the bottom line. On a ticket that is not a duplicate, the unblock is the first block.

### Bad comment

Same shape of ticket, seven-plus paragraphs, everything the document was for pasted into the comment.

```markdown
## Summary
...

## What we found
Reply counts by month, Jun through Aug, with the figure in the ticket corrected from 40 to 12.

## Blast radius
The whole cohort, org by org, with the query.

## Open question
...

## Internal
Resolved identity: user_id, organization_id, the customer's email addresses, and which of the three matching workspaces was picked and why. Routed to the AI SDR area owner because the project is AI SDR.
```

Nothing in the bad comment is wrong. It is all in the wrong place. The headings, the month-by-month breakdown, the corrected figure, the cohort count, the identity resolution, and the `## Internal` block all belong in the document, and the one sentence the reader needed is buried under them.

## Triage investigation document template

```markdown
# Triage investigation

**Ticket**: <ENG-XXXX>
**Classification**: <User Error | Platform Limitation | Bug>
**Organization**: <organization_id> (<org name>)

## Claim
The one testable sentence from Stage 1.

## Root cause
The cause, not the mechanism.

## Evidence
Every current code, production-data, runtime, provider, and customer-context lane from Stage 4: the queries run and what they returned, or `Not applicable: <reason>`, or `Could not run: <reason>`.

## Prior cases
Each investigation-memory match from Stage 4: the ticket it came from, why it looked like this claim, and what current evidence confirmed or disconfirmed it. `None` when memory returned nothing, `Unavailable: <reason>` when it could not be searched.

## Blast radius
N orgs and N users as an exact figure, or the tightest bound with what blocks the exact count. Always with the query that produced it and the date counted.

## Code path
Files and functions in Acquisity/Acquisity that the cause runs through, with the commit the investigation read.

## Unblock
What gets the customer working now, who performs it, whether it has been done, and confirmation that it costs the customer neither data nor money. `None found: <reason>` when there is nothing.

## Ruled out
What was checked and eliminated, so the next agent does not redo it.

## Next steps
What action the root cause warrants.
```

## Master ticket template

The master ticket template and the rules for filling it live in the `engineering-handoff` skill, which Stage 6 loads for the engineering-actionable branch. Nothing in this reference creates or edits a master.

## Unproven branch reporting

When Stage 5 takes the unproven terminal branch, do not force the ordinary templates to claim a classification or root cause. Keep the `## Triage investigation` title and document link in the short comment, lead with the unblock or `None found: <reason>`, then state the known facts, the missing confirmation and who can supply it, and the condition that will reopen the investigation. Do not present a classification, root cause, or blast radius as settled.

Keep the full evidence record in the investigation document. Set `**Classification**: Not settled` and write `Not settled: <missing confirmation and who can supply it>` under Root cause. Preserve Evidence, Prior cases, Blast radius, Code path, Unblock, and Ruled out with the ordinary `Not applicable` and `Not settled` rules, and put the reopen condition under Next steps. Never load `engineering-handoff` or create or attach a master for this branch.
