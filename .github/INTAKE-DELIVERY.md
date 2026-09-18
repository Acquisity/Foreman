# Intake delivery: evidence map and conflict register (ENG-14060)

This records what was verified before the Linear intake pilot is designed, what is still unknown, and the skill conflicts found. Slice 1 fixes only the leaks on the current Slack path. Nothing here changes routing.

## Evidence map: ENG-14042

Observed, from the persisted Slack thread and production Workflow runs:

| Time (UTC, 2026-09-18) | Observed |
| -- | -- |
| 17:27:19 | Acquisity Asks bot files the ask and mentions Foreman. Session `wrun_41M2TRY0VZ0GWY807FHGRZR3HQ` starts 17:27:23. |
| 17:53:37 | Foreman posts an interim status: investigation complete, critic running, quick status. |
| 18:06:59 | Child task run `wrun_41M2TV6GSM0GGZ1H16AZPRHXTS` starts. |
| 18:20:46 | Requester answer posted. The turn that wrote it (`wrun_41M2TTZSVQ0GQMV1BTK94NKHMC`) ends 18:20:48. |
| 18:21:21 | That child task wakes its parent (`wakeTaskAgentRequestParentStep`) and completes 18:21:22. |
| 18:21:27 to 18:22:38 | A new turn runs under `turn-control` of the same session. The recap is posted 18:22:37. |

- Deployment `dpl_DZwLLcLs2X4PjBZjggfxDXSeHQMc` is production `main` at `cb739dc`. The turn model attribute was `gateway/deepseek/deepseek-v4.1-flash`.
- All three Foreman posts are ordinary terminal model messages. `agent/channels/slack.ts` posts every non-tool-call `message.completed` verbatim, with no record that an answer already went out.
- So the recap was the root's terminal message in a turn started by a late child result, and the requester answer went out before that child settled.

Inferred or unknown:

- Whether the late child was the critic or a native delegate. Step payloads are encrypted, so the child's identity and the recap turn's input are not readable.
- Whether the critic verdict preceded the requester answer. The recap says the "background assessment confirmed my applied decisions", which suggests routing was applied before it returned. Not proven.
- The reasoning setting used by the run.

Instructed causes found in authored text (all fixed in slice 1):

- `critic-review.md` step 3 and `triage-handling` told Foreman to post a progress line before the critic, and the Slack final-post rule allowed "normal conversational progress updates".
- Stage 7 placed the reply before memory bookkeeping, and the delegation prompt said to use later completions to "answer the user", with nothing forbidding a second closing message.
- `turn.failed` put the raw error name and message in the thread.

## Delivery facts that bound the design

- eve gives authored Slack channel code no way to tell a user turn from a turn started by a delegated result: `turn.started` carries only `turnId`, and the task-triggered `message.received` is not a Slack channel event. A code-side "already answered" flag would therefore also swallow the real answer after an interim post. It was not built.
- The supported suppression is eve's `<eve-empty-delivery/>`: when it is the whole response, eve emits `message.completed` with a null message and the existing blank branch posts nothing. Covered by a channel test.
- The Linear channel (`agent/channels/linear.ts`) stamps trusted plus investigation memory, never intake-only, injects no skill list, uses eve's default rendering (final text becomes a durable `response` activity), and uses the default `steer` turn policy, so a follow-up prompt cancels the running turn. There is no stop interception on Linear.
- The root has no Slack write tool. Posting to an arbitrary thread exists only in server code (`agent/lib/support/slack.ts` `postSupportMessage`, idempotent through `client_msg_id`).
- The Asks receiver (`acquisity-asks-receiver.vercel.app`) is not in this repository. Its repository, template settings, Foreman mention, issue-to-thread mapping, and reply sync are unverified. This is the external dependency for the pilot.

## Conflict register

Paths are under `agent/skills/`. TH is `triage-handling`, EH `engineering-handoff`, HL `incident-hotlane`, CR `triage-handling/references/critic-review.md`, RP `triage-handling/references/reporting.md`, SW `slack-wording`.

| Id | Where | Conflict | Class | Status |
| -- | -- | -- | -- | -- |
| A1 | TH Stage 5 Bug bar, HL, CR gate | Bug needs a counted blast radius; hotlane allows `Unknown` and `NEEDS_HUMAN_URGENT`, but loads only after a Bug is selected, so an unproven high-risk case stops before it | contradiction and ordering | Open. Proposed: let the unproven branch run the hotlane assessment when the condition is high-risk. The Bug bar stays. Needs Aaron, because it changes who is paged |
| A2 | `triage-investigate` blast radius, TH Bug bar | "tightest bound with the blocker named" against "counted by a query" | unclear exception | Open, resolve with A1 |
| B1 | RP line 7, TH Stage 6 order | Reporting says state, priority, and labels are already saved; the comment is written before routing | ordering | Open. Proposed: reword RP, no behavior change |
| C1 | TH Stage 6, EH return text | TH treats the requester comment as already written; EH says Stage 6 writes it after the return | duplicate responsibility | Open, resolve with B1 |
| D1 | TH "exactly once", EH version precondition, `triage-critic` invalidation | One review and one adjudication, but a changed document version or master candidate invalidates it with no re-review allowed | contradiction | Open. Proposed: one critic delegation, Foreman self-adjudication may repeat per changed version, the post-routing Review save is exempt |
| E1 | SW Bug wording against SW promise rule | "the team is working on a fix" against no unverified promises | contradiction | Fixed in slice 1 with Aaron's rule: only when a matching engineering issue is In Progress or there is current explicit evidence of active work; no date, no deployed-fix claim |
| F1 | TH state sentence against TH non-engineering close | Support paths are Todo, yet prose says the report closes | wording | Open |
| F2 | `triage-investigate` duplicate step against TH | "comment and route in one update" against comment then one route call | wording | Open |
| G1 | CR step 3, TH review paragraph, Slack final-post rule | Instructed interim progress post | duplicate responsibility | Fixed in slice 1 |
| G2 | TH Stage 7 order, delegation prompt | Reply before memory work; late results produce a second terminal message | ordering | Fixed in slice 1 |
| H1 | EH master window, `agent/tools/find_related_issues.ts` | The 30-day master window is keyed to the Slack intake-only stamp; a Linear session has no cutoff | unclear exception | Open. The pilot must carry a verified intake stamp into Linear |
| H2 | `agent/lib/slack-intake.ts` boundary against `agent/lib/linear-context.ts` | No-implementation boundary, skill list, and single-issue rule are injected only on Slack | unclear exception | Open, same slice as H1 |
| H3 | TH Stage 7 | The reply rule points at a Slack stamp a Linear session never receives | unclear exception | Open, same slice as H1 |

Routing rules are untouched: projects, area owners, master assignee inheritance, states, priority, labels, duplicate and parent handling, fallback, and master eligibility all read as before.

## Next slices and what blocks them

1. Linear intake context: a verified intake stamp on Agent Sessions carrying the no-code boundary, skill selection, and the 30-day window (H1 to H3). Needs the receiver's template and trigger facts.
2. One requester delivery path from a Linear-owned investigation to the Slack thread, idempotent through `client_msg_id`, after native sync is checked. Needs the receiver's issue-to-thread mapping.
3. Remaining register items A1, A2, B1, C1, D1, F1, F2.
