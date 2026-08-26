---
description: "Turn an approved, engineering-actionable triage investigation into exactly one causal Linear master with the customer report parented to it: search, match by cause, reuse or create, apply the approved priority and fast-lane state, and read every write back. Load from triage Stage 6 only for that branch."
---

# Engineering handoff

Create durable engineering work from an approved diagnosis without turning every customer report into its own investigation. The customer ticket never becomes the engineering ticket: a master owns the root cause, and the report attaches to it. One root cause gets one master, whatever the number of reports or implementation steps.

`triage-investigate` still owns investigation, classification, the non-engineering outcomes, the requester comment, the Slack reply, memory bookkeeping, the numeric priority, the area-routing roster, and the customer ticket's final state, labels, priority, and project. This skill owns finding or creating the master, the customer ticket's `parentId` and `assignee` that link it to the master, the content boundary between report and master, and proving the writes landed.

## Preconditions

All of these hold before anything is written:

- Stage 5 settled the classification as `Bug` and the handling path as `Engineering Todo`.
- The `Triage investigation` document is attached to the customer ticket and current.
- When the workflow ran the critic, its verdict was `APPROVE` for this exact document version: the document id and `updatedAt` the critic echoed in `reviewed` still match what Linear returns now. A changed document needs a new review before any structural write.
- When the workflow ran `incident-hotlane`, its route is `HOTLANE` or `STANDARD_ENGINEERING`; `NEEDS_HUMAN_URGENT` never reaches this skill. When the workflow did not run it, treat the route as `STANDARD_ENGINEERING`: proceed normally and apply no `fast-lane` label.
- The master search below has been run in this pass, not carried over from an earlier one.

If any precondition fails, write nothing structural. Record the blocker in the investigation document and leave the report where Stage 5 put it.

## Match by cause, not symptom

Parent the report to an existing master only when all of these match:

- the same failing invariant or decision;
- the same reachable code, job, state transition, provider failure, or dependency boundary;
- compatible triggering conditions; and
- the fix for one would prevent the other.

A shared symptom, error string, component, provider, or customer outcome is not enough. Two tickets reporting the same visible failure with different causes need two masters. Two tickets with different symptoms and one cause share a master. When uncertain, add a `related` link and say so in the document; never parent speculatively.

## Search for the current master

Search on four axes: the cause, the Stage 4 code path, the provider failure, and the symptom. The code path is the strongest of the four, because two reports running through the same function are almost certainly one bug.

1. For every query, call `linear__list_issues` with `team: "8eaf95ab-56ac-4490-8253-f6a96793dc40"` (the Engineering Team id; the name `"Engineering"` silently returns nothing, so pass the id) and `limit: 250`.

   When the active context says this is an intake-only Slack workflow, search no further than 30 days back by also passing `createdAt: "-P30D"` on every query. Outside an intake-only Slack workflow, including a Linear Agent Session, preserve the general triage behavior: do not pass a `createdAt` filter, and consider matching masters regardless of creation date.

   In every context, while `hasNextPage` is true, repeat the identical filtered query with the returned `cursor`, accumulating candidates from every page until `hasNextPage` is false.

   Do not filter this search by label. A master carries no marker label, so a label filter would match nothing and every report would create another master. A master is recognised by what it is: an ENG issue owning this root cause, usually already parenting customer reports.
2. In an intake-only Slack workflow, apply the 30-day cutoff before selecting a candidate as the current master or setting it as this report's parent. A candidate created exactly 30 days ago remains eligible; one created more than 30 days ago, even by one second, is stale and cannot become this report's parent. Reject an older candidate for current-master selection and parent attachment if it appears through another issue's relations, investigation memory, an unbounded search result, or prior knowledge. Outside that Slack workflow, do not apply the recency cutoff. In every context, match eligible candidates on root cause, never on symptom.

The Slack intake recency window exists so masters describe a current cluster of customer reports and preserve real-time blast-radius visibility. It narrows the candidate set only in that workflow. It never weakens the similarity, evidence, product-area, or duplicate safeguards above.

## Reuse an existing master

If an eligible master already owns the cause:

1. Read the master and the report with their current relations first. If the report is already parented to this master, that is done; do not append it again.
2. Read the master's assignee, then set this ticket's `parentId` to that master and its `assignee` to the master's assignee in the same `save_issue` call (the field is `assignee`, not `assigneeId`), so the child never sits under a master owned by someone else. Where the master has no assignee, fall back to the area-routing roster in `triage-investigate` Stage 6 and say in the document that the master was unassigned.
3. Comment the new evidence on the master in aggregate form, re-count the blast radius, update the master's section with the new figure and date, and re-weigh its priority. A second independent report is frequency evidence. The child count on the master is how anyone sees how many customers hit this without asking, so the parent link matters more than a prose figure that ages.
4. Apply the approved hotlane state: add the `fast-lane` label to the master when the approved route is `HOTLANE`, preserving the master's other labels as a union. Never lower the master's priority because of a workaround or one more report.

## Create one master

If no eligible master owns the cause, create one with the template below, on the ENG team, in the product project Stage 6 selected from completed evidence (never the report's incoming intake project; when Stage 6 could not determine one, leave the master unprojected and say so in the document), labelled with the type, priority per Stage 5, `fast-lane` when the approved route is `HOTLANE`, and assigned to the area owner from the roster in `triage-investigate` Stage 6. Then set this ticket's `parentId` to it and its assignee to that same area owner, in one `save_issue` call. In an intake-only Slack workflow, eligibility includes the 30-day cutoff, and an older matching master may be related for history but never reused as the parent. In other contexts, eligibility has no recency cutoff.

Do not create a master because a ticket has several acceptance criteria or several steps. One master per root cause.

File containment, customer recovery, prevention, or observability work as child or related implementation issues under the master only when it is independently deliverable, has a different owner or risk, or can ship separately. Implementation children are not customer reports and never count toward affected-workspace totals.

## Content boundary

The customer report keeps everything customer-specific: the source link, workspace and customer identity, screenshots, production rows, bounded logs, the customer's timeline and unblock, and the attached investigation document. It is evidence, not the engineering owner.

The master carries only sanitized, aggregate engineering context: the cause, the code path, the blast radius figure with its query and date, and links to the report children. No organization id, email, customer row, or conversation excerpt. A Linear document inherits the visibility of the issue it hangs from, so the investigation document is never attached to a master.

## Read back before finishing

After the writes, read the master and the report again and confirm: the parent relation, the assignee on both, the master's project, priority, label union including `fast-lane` when approved, and the report link from the master. If any of it disagrees with what was intended, stop and report the mismatch in the investigation document. Never create a second master as a recovery step; a duplicate master is worse than a missing link.

Changing a diagnosis or moving a report between masters needs a new investigation document version and, where the workflow includes it, a new critic review, plus an audit comment on both affected tickets. Never silently remove or re-parent a report.

## Return to Stage 6

Hand back the master id, whether it was reused or created, the parent and assignee that were set, the priority and label state, and any implementation children filed. Stage 6 writes the requester comment and Stage 7 the Slack reply; this skill communicates with nobody.

## Master ticket template

```markdown
## Overview

One to three plain-language sentences: what is broken and why it matters.

## Problem

The problem from the user's or operator's perspective.

## Root cause

The cause, with the file and function it lives in.

## Blast radius

How many orgs and users are affected, as an exact figure where one is reachable, with the query that counted it and the date counted. Where exact is not reachable, the tightest bound and what blocks the exact figure. Confirmed affected and potentially exposed stay separate. Never an adjective.

## Proposed fix

The end-to-end behavior that should change, without a layer-by-layer plan.

## What's included

Decided scope, important exclusions, dependencies, and any separately filed containment, recovery, prevention, or observability work.

## Regression seam

The public boundary, trigger, and observable red-before, green-after behavior a test can prove.

## Done when

- Checkable observable outcome.
- Checkable observable outcome.
- A regression test proves the causal mechanism at the named seam.

## Reports

The customer tickets this master owns, as Linear links.
```

Where evidence proves a section cannot apply, write `Not applicable: <short reason>`. Where it is unknown, write `Not settled: <what is missing and who can supply it>`. Never pad a thin root cause into a full-looking ticket.
