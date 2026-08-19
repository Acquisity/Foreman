---
description: "Daily SLA bug report: find new SLA bugs (Bug + Urgent/High, SLA started at or after the window the dispatch provides) for a feature, investigate each with the right tool, and post a bottom-line report to the feature's Slack channel tagging James Keeble. Load for every sla-report schedule dispatch."
---

# SLA investigation

Produce a bottom-line daily report for one feature's new SLA bugs. The schedule dispatches one session per feature channel; this skill tells the session how to find the bugs, which tool answers which question, and how to write the report.

## What counts as a new SLA bug

A bug is in scope when all of these hold:

- `label` includes `Bug`.
- `priority` is `Urgent` (1) or `High` (2).
- `slaStartedAt` is at or after the window start the dispatch provides.

Bugs with no `slaStartedAt` are out of scope. Ignore `Done`, `Canceled`, and `Duplicate` states.

## Feature to project mapping

Categorize by the Linear `project` field, not the title. The known mapping:

| Feature | Linear projects |
| --- | --- |
| Cold Email | Cold Email Core, Cold Email Leads, Cold Email Agent, Cold Email Infra |
| AI SDR | AI SDR Core, AI SDR Scheduling, AI SDR Escalation & Classification, AI SDR Inbox & UI |
| CRM | CRM, CRM Calendar Scheduling, CRM Phone Calling & Texting |
| AI Website Builder | AI Website Builder |
| Whitelabel Partners | Whitelabel Partners |

Keep this mapping current. If a bug's project does not map to any feature, skip it.

## Tools: what each is for and how to use it

Reach for the smallest tool that answers the question. Do not open every tool for every bug.

### Linear (linear connection)

What it is: the source of truth for the ticket list and ticket details.

What it's for: finding the new SLA bugs and reading their title, description, project, labels, priority, and SLA fields.

How to use it:
- `list_issues` with `team: "Engineering"`, `label: "Bug"`, `priority: 1` and `priority: 2` (two calls). Pass `fields: ["identifier", "title", "priority", "project", "labels", "state", "slaStartedAt", "slaBreachesAt", "url"]`, `includeArchived: false`, and `limit: 250`, and follow `hasNextPage` with the returned cursor until it is false. Then filter locally to `slaStartedAt` at or after the `since` timestamp the dispatch provided, and the feature's projects.
- `get_issue` for the full description when the summary is truncated.

### Acquisity codebase (Acquisity/Acquisity)

What it is: the product monorepo (Next.js app, `packages/jobs` Inngest functions, `packages/db` schema).

What it's for: tracing what the bug actually touches, so "what is it" is grounded in code, not just the ticket title.

How to use it: `prepare_repository` with `Acquisity/Acquisity`, then `grep` and `read_file` to follow the code path named in the ticket.

### PlanetScale (planetscale connection)

What it is: read-only production Postgres.

What it's for: blast radius. Counting affected rows, workspaces, or users when the bug is a data problem.

How to use it: `planetscale__planetscale_execute_read_query` against the production branch. Read only; never run a write. Prefer a bounded `COUNT` or a small `SELECT` over a full scan.

### Inngest (inngest connection)

What it is: the background-job platform (the `ai-clients` app).

What it's for: confirming whether a job is failing, how often, and how many runs are affected.

How to use it: `list_runs` or `list_function_runs` filtered by the function named in the ticket, `get_run_trace` for one failing run's steps.

### Sentry (sentry connection)

What it is: error tracking.

What it's for: error volume and affected users. The `userCount` on a matched issue is the fastest blast-radius signal.

How to use it: `sentry__search_issues` for the error signature from the ticket, then `sentry__search_events` for the event and affected-user counts.

### Axiom (axiom connection)

What it is: production structured logs.

What it's for: log evidence when the ticket names a symptom but not an error, and for error rates or durations over a window.

How to use it: `queryDataset` with an APL query over the relevant dataset, bounded to a recent window.

## Report format

Post one message covering every in-scope bug for this feature, bottom line, natural language, no em dashes, no bold. Tag James Keeble with `<@U0BA7JK9XRV>` once at the top, then repeat the block below for each bug. The session delivers a single channel message, so do not plan on separate posts.

```
<@U0BA7JK9XRV> <count> new SLA bug(s) in <feature>

<one natural language line dont use jargon and speak coherently. State it simply and concisely, like one human talking to another, grounded in the ticket and code>

Problem from user perspective: <what is the user experiencing with this bug. hows it blocking them etc.>
Root cause identified: <if yes. natural language explain in one sentence. if no. say unsure>
Users/workspaces affected (this is blast radius): <number amount. dont list out every user or workspace>
Ticket link: <linked ENG_XXXX>
```

All in actual simple language/laymans terms. If blast radius cannot be determined quickly, say so rather than guessing. If there are no new SLA bugs, post nothing.
