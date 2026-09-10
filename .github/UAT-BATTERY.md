# UAT battery

Every preview UAT runs every core scenario here, plus the conditional ones the ticket's spec turns on, in the Foreman preview testing channel `C0BUF4GU8C8` against the bot `U0BTGKF57T7`. The battery is the list of what Foreman has already promised, re-proven on every pull request. A ticket that passes UAT adds its Layer 1 scenario here in the same pull request when the behavior is one production users hit.

Rules. Fixtures are real, recent, read-only cases named by id, never by customer name or email. Each carries the date it was chosen; a fixture older than 30 days is swapped by the orchestrator when it writes the next spec. A scenario marked serial runs with no other thread active. Every scenario has a poke: something done mid-turn to try to break it. A failing scenario that passed in the previous report is a regression and fails the pull request; one that was already failing is a surprise ticket.

Preview is not an intake-only channel unless `SLACK_INTAKE_ONLY_CHANNELS` in the Preview environment lists `C0BUF4GU8C8`; the executor records which. Scenarios here test the direct path.

## Core, every run

### B1 Billing ask with a fixture

Covers: billing-triage skill, lookup_customer, Autumn and Stripe reads, closing reply with figures and ticket link.
Fixture: Linear `ENG-13405` (discount code not working), chosen 2026-09-04, read-only.
Send: `<@U0BTGKF57T7> <LINEAR-ID> <PR-URL> <SHA>. A rep asks: the customer on ENG-13405 says the discount code we issued is not applying at checkout. Look into it and tell me what you find.`
Expect: the reply states what was checked and where, gives a finding or names the one input it still needs, and ends with a clickable ticket link. No name of a person as approver.
Negative control: `<@U0BTGKF57T7> <LINEAR-ID> <PR-URL> <SHA>. What does the billing-triage skill do? Do not look anything up.` Expect a description, no lookups.
Poke: 60 seconds in, reply in the thread with `any update?`. Expect no lost request and no duplicate answer.
Time bound: 10 minutes.

### B2 Intercom conversation triage

Covers: intercom-triage-investigate, Intercom app-scoped read, customer-ready reply, ticket identifier link.
Fixture: Intercom conversation `215475776526481` (subscription cancellation demand, closed 2026-09-03), chosen 2026-09-04, read-only.
Send: `<@U0BTGKF57T7> <LINEAR-ID> <PR-URL> <SHA>. Triage Intercom conversation 215475776526481 and draft the reply to the customer.`
Expect: a diagnosis with the evidence read from the conversation, a customer-ready reply draft, and the ticket identifier as a link on the last line. No credentials, no raw email addresses in the reply.
Negative control: `<@U0BTGKF57T7> <LINEAR-ID> <PR-URL> <SHA>. Summarize what an Intercom triage covers, without opening any conversation.`
Poke: while it works, post a second top-level mention (B3). Expect both threads to finish with their own answers.
Time bound: 10 minutes.

### B3 Linear ticket investigation

Covers: triage-investigate, Linear reads, PlanetScale and Instantly read tools, investigation memory recall, handoff comment quality.
Fixture: Linear `ENG-13348` (positive replies, no booked calls), chosen 2026-09-04, read-only.
Send: `<@U0BTGKF57T7> <LINEAR-ID> <PR-URL> <SHA>. Investigate ENG-13348. Is this user error, a platform limit, or a bug? Show the evidence.`
Expect: one of the three verdicts, the evidence path, the owning product area, and similar past cases if any. No customer identifiers in the Slack reply.
Negative control: same prompt with `ENG-00000`. Expect a plain "ticket not found" reply, no invented investigation.
Poke: at 2 minutes reply `also check whether the inbox is still connected`. Expect the addition to be answered in the same thread after the main answer.
Time bound: 15 minutes.

### B4 Screenshot on the mention

Covers: attachment staging, attachment context line, vision subagent, uploadPolicy.
Fixture: `.github/uat-fixtures/demo-dashboard.png`, a 1106 by 940 screenshot of the Trivox AI demo workspace dashboard (seeded demo data, no customer data), captured 2026-09-04 through Orca's browser. Upload with the Slack Web API `files.uploadV2` using Aaron's token.
Send with the file attached: `<@U0BTGKF57T7> <LINEAR-ID> <PR-URL> <SHA>. What does this screenshot show and what would you check first?`
Expect: the reply names what the dashboard shows (positive responses, appointments over time, deals by sales rep, cumulative cash) and what it would check first. The diagnostic confirms the vision subagent was called with the staged path.
Negative control: the same message with `.github/uat-fixtures/demo-dashboard.pdf` (the same page exported as a one-page PDF) attached instead. Expect the turn to complete and the reply to say the file was not read. Before ENG-13454 merges this control is expected to fail; record it, do not count it.
Poke: none.
Time bound: 5 minutes.

### B5 Stop and queue (serial)

Covers: literal stop, queue turn policy, progress lines, status echo, cancellation notice.
Fixture: none.
Send: `<@U0BTGKF57T7> <LINEAR-ID> <PR-URL> <SHA>. Read every skill you have and summarize each one in three sentences, one at a time, checking the repository Acquisity/Foreman for each.` This is chosen to run several minutes.
At 60 seconds reply in the thread: `<@U0BTGKF57T7> one more thing, also count the tools.` Expect either a queued line or the addition answered after the main reply, never a lost request.
At 3 minutes reply: `<@U0BTGKF57T7> stop`. Expect the cancellation notice within one step and no further progress line.
Record: whether a progress line appeared, whether the status echo was visible before and after it, and the time from stop to notice.
Time bound: 8 minutes.

### B6 Repository mention without a URL

Covers: repository selection rules, prepare_repository, no false binding on a bare slug.
Fixture: none.
Send: `<@U0BTGKF57T7> <LINEAR-ID> <PR-URL> <SHA>. In Acquisity/Foreman, which file decides which lanes carry the GitHub tools? Just name the file.`
Expect: the bot prepares the repository from the slug and names `agent/lib/repository-lane.ts`.
Negative control: `<@U0BTGKF57T7> <LINEAR-ID> <PR-URL> <SHA>. The path channels/github.ts came up in a review. Without opening any repository, what would you expect a file with that name to do?` Expect an answer with no repository prepared.
Poke: none.
Time bound: 6 minutes.

## Conditional, turned on by the spec

### C1 Factory run (serial, long)

On when the diff touches the factory path, long-turn behavior, station prompts, or the GitHub channel.
Fixture: a scratch Linear ticket in the Foreman project titled `UAT scratch: add a one-line comment` created by the orchestrator for this run, plus repository `Acquisity/Foreman`. The bot may open a pull request from this; the orchestrator closes it afterwards.
Send: `<@U0BTGKF57T7> <LINEAR-ID> <PR-URL> <SHA>. Please begin work on <SCRATCH-ID>, repo is Acquisity/Foreman, use the factory.`
Expect: a 5-minute progress line, further lines at the cadence the ticket promises, the status echo visible after each, and a closing post with the pull request link.
Poke: at 12 minutes post `<@U0BTGKF57T7> update?`. Expect a queued line or an answer, never silence. Do not send stop in this thread.
Time bound: 45 minutes.

### C2 Factory stop (serial, long)

On with C1.
Send the same request on a second scratch ticket, wait for the 5-minute line, then reply `<@U0BTGKF57T7> stop`. Expect the cancellation notice within one step boundary and no pull request opened after it.
Time bound: 20 minutes.
