# Eve 0.81.1 upgrade evidence and acceptance

[ENG-15868](https://linear.app/acquisity/issue/ENG-15868) upgrades Foreman from Eve 0.54.2 to Eve 0.81.1, AI SDK (`ai`) 7.0.148 and `@github-tools/eve-extension` 0.8.1, and retires `@agent-browser/eve`. The children below landed on the integration branch `feature/eng-15868-eve-0.81.1`. This file records the cutover runbook and the acceptance evidence. It is not Production acceptance until the checks below are filled in and Aaron approves the merge.

## Approved decisions

Approved by Aaron on 2026-10-21:

- The browser add-on is dropped. `@agent-browser/eve` 0.39.1 needs tool contract 44, which Eve 0.81.1 no longer provides, so no lane carries browser tools.
- `ask_question` is not added. Eve 0.65 stopped shipping it as a default tool, and Foreman adds none, so no session can park on a question.
- Foreman adopts eve's task model. Native agent, critic and vision calls hold the turn, each result arrives in that same turn as a `task.result` once its task settles, and the root uses `eve__task_wait` and `eve__task_cancel`.
- Hooks stop turns with `ctx.cancel()`. Since Eve 0.68 a hook that throws no longer fails the turn.
- The cutover drains and retires every 0.54.2 session; no session is handed off across the upgrade.
- Rollback is a revert commit on `main`, deployed after the upgraded sessions are reset through the retained 0.81.1 deployment. Never `vercel rollback`.

## Child PRs

All merged into `feature/eng-15868-eve-0.81.1`.

| Ticket | PR | Merge commit | Change |
| --- | --- | --- | --- |
| ENG-15869 | [#225](https://github.com/Acquisity/Foreman/pull/225) | `ddbba1e` | Bump eve to 0.81.1, retire the browser add-on, migrate the sandbox API |
| ENG-15872 | [#226](https://github.com/Acquisity/Foreman/pull/226) | `451bc4c` | Stop support turns with `ctx.cancel()` |
| ENG-15871 | [#227](https://github.com/Acquisity/Foreman/pull/227) | `7efabc9` | Move Foreman to eve's task model and renamed tools |
| ENG-15870 | [#228](https://github.com/Acquisity/Foreman/pull/228) | `58239ae` | Port the Slack channel to eve's renderer API |
| ENG-15873 | [#230](https://github.com/Acquisity/Foreman/pull/230) | `453150e` | Port evals to the eve 0.81 eval API |
| ENG-15874 | [#229](https://github.com/Acquisity/Foreman/pull/229) | `0a21db6` | Remeasure the capability report and built-GitHub proof on eve 0.81.1 |
| ENG-15910 | [#231](https://github.com/Acquisity/Foreman/pull/231) | `3b23fd3` | Build the warm snapshot from eve 0.81.1's sandbox image |

## Why sessions cannot cross the upgrade

- 0.57: turns run inside the session workflow. A session started before it continues on its next turn only through import, so sessions are retired before any rollback across it.
- 0.69: extension configuration and state belong to each mount, and session handoffs across this boundary are rejected in both directions.
- 0.70.0 and 0.75: the handoff checkpoint changed shape and then version, so no idle session hands off across them.
- 0.69 also moved the message stream to version 26. Clients that accept only up to 25 reject it. Foreman's own consumers run on the same eve, so only external tooling, such as the workflow CLI used for production inspection, needs a matching version.

So every session started on 0.54.2 is drained and retired through the 0.54.2 deployment before the 0.81.1 deployment takes the trigger. The first message in each old Slack thread then starts a fresh internal session with bounded visible history; hidden notes, tool results and sandbox state are not carried over.

## Production cutover runbook

0. Before replacing the snapshot, record the current Production and general Preview `VERCEL_SANDBOX_BASE_SNAPSHOT_ID` values in private operator notes, with only their last four characters in this document (today `nHgK`). Keep the 0.54 snapshot for the rollback window; never delete it. Before the cutover deploy, rebuild the warm snapshot with the 0.81 builder. Run `rebuild_warm_snapshot` (`agent/tools/rebuild_warm_snapshot.ts`, which calls `createWarmSnapshot` in `agent/lib/repository-snapshot.ts`) from an attended session on a 0.81.1 deployment. It builds from `vcr.vercel.com/vercel/eve/base:0.81.1`. Set Production `VERCEL_SANDBOX_BASE_SNAPSHOT_ID` to the new id, and replace the general Preview value too. Today Production and general Preview hold the 0.54 snapshot ending `nHgK`, which fails every 0.81.1 sandbox with "chdir /vercel/sandbox: no such file or directory"; the 0.81 snapshot set branch-scoped for the staging branch ends `NqQg`. Read the value back after setting it.
   - TODO(rehearsal): exact `vercel env` commands used to replace and read back both values.
1. Record the current trigger destinations and which schedules are enabled, then quiet ingress on the 0.54.2 deployment. Pause the Slack and Linear connector triggers, and stop the schedules that start sessions: `sla-report`, `ai-sdr-report`, `intercom-handoffs` and `intercom-followups` (`foreman-costs-report` posts without a model turn). Pausing Slack alone does not stop a schedule. Read back each trigger's destinations to confirm nothing routes to Foreman.
   - TODO(rehearsal): exact command to pause each connector trigger and its read-back.
   - TODO(rehearsal): exact way the schedules were held for the window.
2. Inventory active and parked sessions on the 0.54.2 deployment, roots and children, and let active work drain. Record every session ID.
   - TODO(rehearsal): exact inventory command and its output shape.
3. Reset each recorded session through the 0.54.2 deployment: `POST https://<0.54.2 deployment>/eve/v1/session/<sessionId>/reset` with body `{"reason":"eve 0.81.1 cutover"}`. The route uses the eve channel's `vercelOidc()` auth, so send `Authorization: Bearer <Vercel OIDC token for the Foreman project>`, plus the deployment protection bypass header when protection applies. A `"reset"` result retires the session; `"no_active_session"` means it was already inactive. Record each result.
   - TODO(rehearsal): exact token source and full curl line that worked.
4. Merge and deploy the 0.81.1 commit to `main`. Verify the Production deployment is READY on the expected SHA, resume the triggers and schedules, read back the trigger destinations, and continue one real Slack thread: confirm a fresh internal session, bounded visible history, a real provider read and a normal reply. Keep the 0.81.1 deployment URL for rollback.
   - TODO(rehearsal): exact commands for the SHA check and trigger resume.
5. Rollback, if needed: quiet ingress as in step 1, drain, and reset every upgraded session through the retained 0.81.1 deployment as in step 3. Restore Production and general Preview `VERCEL_SANDBOX_BASE_SNAPSHOT_ID` to the recorded 0.54 values before deploying a revert commit on `main`. Verify the reverted deployment is READY on the expected SHA, then restore the recorded trigger destinations and previously enabled schedules, leaving disabled support schedules as they were. Read both back, then continue an existing Slack thread and a Linear session through real connector ingress. Verify a fresh sandbox session and a real provider read. Never `vercel rollback`. A code revert does not restore prior internal session state.

## Checks

| Check | Status | Evidence |
| --- | --- | --- |
| `pnpm validate` | Pending | |
| `npx eve info` | Pending | |
| `pnpm build` | Pending | |
| `pnpm verify:built-github` | Pending | |
| `pnpm report:capabilities` | Pending | |
| C1 Quiet ingress and read back | Pending | |
| C2 Inventory and drain | Pending | |
| C3 Reset through the 0.54.2 deployment | Pending | |
| C4 Deploy, resume, continue a thread, then rollback rehearsal | Pending | |
| Master QA: widget | Pending | |
| Master QA: Linear | Pending | |
| Master QA: Slack | Pending | |
| Master QA: evals | Pending | |

## Rehearsal transcript

Pending.

## READY deployment and commit

Pending.
