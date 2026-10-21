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
- 0.69 also moved the message stream to version 26. Clients that accept only up to 25 reject it. Foreman's own consumers run on the same eve; external eve stream clients must accept version 26. The rehearsal used Workflow CLI 5.0.6, which reads raw chunks and does not negotiate eve stream versions; a decrypted stream inspection was not exercised.

So every session started on 0.54.2 is drained and retired through the 0.54.2 deployment before the 0.81.1 deployment takes the trigger. The first message in each old Slack thread then starts a fresh internal session with bounded visible history; hidden notes, tool results and sandbox state are not carried over.

## Production cutover runbook

0. Before replacing the snapshot, record the current Production and general Preview `VERCEL_SANDBOX_BASE_SNAPSHOT_ID` values in private operator notes, with only their last four characters in this document (today `nHgK`). Keep the 0.54 snapshot for the rollback window; never delete it. Before the cutover deploy, rebuild the warm snapshot with the 0.81 builder. Run `rebuild_warm_snapshot` (`agent/tools/rebuild_warm_snapshot.ts`, which calls `createWarmSnapshot` in `agent/lib/repository-snapshot.ts`) from an attended session on a 0.81.1 deployment. It builds from `vcr.vercel.com/vercel/eve/base:0.81.1`. Set Production `VERCEL_SANDBOX_BASE_SNAPSHOT_ID` to the new id, and replace the general Preview value too. Today Production and general Preview hold the 0.54 snapshot ending `nHgK`, which fails every 0.81.1 sandbox with "chdir /vercel/sandbox: no such file or directory"; the 0.81 snapshot set branch-scoped for the staging branch ends `NqQg`. Read the value back after setting it.
   - Replacing and reading back the Production and general Preview snapshot values was not exercised in this Preview rehearsal; the exact commands remain unverified.
1. Record the current trigger destinations and which schedules are enabled, then quiet ingress on the 0.54.2 deployment. Pause the Slack and Linear connector triggers, and stop the schedules that start sessions: `sla-report`, `ai-sdr-report`, `intercom-handoffs` and `intercom-followups` (`foreman-costs-report` posts without a model turn). Pausing Slack alone does not stop a schedule. Read back each trigger's destinations to confirm nothing routes to Foreman.
   - For each verified connector ID, write `{"destinations":[]}` to `pause.json`, then run `npx vercel api /v1/connect/connectors/<connector_id>/trigger-destinations --scope team_ZU8UTsvGgsLZaLDc8pUAzict -X PATCH -H "Content-Type: application/json" --input pause.json --raw`. Read back with `npx vercel api "/v1/connect/connectors/<connector_id>?teamId=team_ZU8UTsvGgsLZaLDc8pUAzict" --scope acquisity | sed '/^$/d' | jq -c '{triggers,triggerDestinations}'`. The rehearsal returned `triggerDestinations: null` while `triggers.enabled` stayed true. Events arriving while paused are dropped, not queued.
   - Schedule quieting was not exercised. Preview support flags remained unset; holding enabled Production schedules is still unverified.
2. Inventory active and parked sessions on the 0.54.2 deployment, roots and children, and let active work drain. Record every session ID.
   - Rehearsed Preview inventory: `npx workflow inspect runs -b vercel -e preview --project foreman --team acquisity -j --since 1h --limit 100`. Filter by `deploymentId`, retain `workflowName=workflow//eve//workflowEntry`, and inspect attributes `$eve.type` (`session` or `subagent`), `$eve.trigger` (`channel:slack`, `channel:linear` or `subagent`) and `$eve.parent`. Adapt the environment and time window for Production and verify inventory completeness; `--limit 200` returned nothing in rehearsal.
   - Workflow status `running` includes active and idle sessions on 0.54.2. Read `npx vercel logs --scope acquisity --project foreman -d <deployment_id> --since 30m -n 1000 -j` and parse `.logs[].message` JSON: `turn.started` without completion means active, while `turn.completed` marks waiting. No parked state is reachable from Slack on 0.54.2; an idle waiting session was the rehearsal equivalent.
3. Reset each recorded session through its immutable 0.54.2 deployment host. Obtain the project's `VERCEL_OIDC_TOKEN` through `npx vercel env pull --environment development` in a private operator context, then load it into `$OIDC` without printing it. Run `curl -X POST https://<immutable deployment host>/eve/v1/session/<sessionId>/reset -H "Authorization: Bearer $OIDC" -H "x-vercel-trusted-oidc-idp-token: $OIDC" -H "Content-Type: application/json" -d '{}'`. The same token satisfies `vercelOidc()` and Preview protection through the trusted-IdP header; no automation bypass secret was needed. Record `reset` or `no_active_session` for each session.
   - On 0.54.2, resetting a root cancelled its children, so their later resets returned `no_active_session`. Child `sessionTimeoutWorkflow` timers can remain `running` after cancellation; expect these harmless timers separately in the inventory rather than treating them as active child sessions.
4. Merge and deploy the 0.81.1 commit to `main`. Verify the Production deployment is READY on the expected SHA, resume the triggers and schedules, read back the trigger destinations, and continue one real Slack thread: confirm a fresh internal session, bounded visible history, a real provider read and a normal reply. Keep the 0.81.1 deployment URL for rollback.
   - Resume with the same `trigger-destinations` PATCH and a JSON file containing `{"destinations":[<one recorded destination>]}`. Preserve the destination's `projectId`, `path` (`/eve/v1/slack` or `/eve/v1/linear`) and target branch, then use the same read-back command to confirm exactly one destination. Rehearsal read-backs showed staging at 18:11:42Z, revert at 18:14:08Z, and staging again at 18:16:27Z on 2026-10-21. The exact SHA/READY read-back command was not recorded; that command remains unverified.
5. Rollback, if needed: quiet ingress as in step 1, drain, and reset every upgraded session through the retained 0.81.1 deployment as in step 3. Restore Production and general Preview `VERCEL_SANDBOX_BASE_SNAPSHOT_ID` to the recorded 0.54 values before deploying a revert commit on `main`. Verify the reverted deployment is READY on the expected SHA, then restore the recorded trigger destinations and previously enabled schedules, leaving disabled support schedules as they were. Read both back, then continue an existing Slack thread and a Linear session through real connector ingress. Verify a fresh sandbox session and a real provider read. Never `vercel rollback`. A code revert does not restore prior internal session state.

## Checks

G2 local evidence was collected from a clean archive of `3b23fd3` on 2026-10-21. The accepted worker report is `/tmp/claude-1000/eng15875-env/REPORT.md`; logs are under `/tmp/claude-1000/eng15875-env/`. These Preview passes do not establish Production snapshot replacement or schedule quieting.

| Check | Status | Evidence |
| --- | --- | --- |
| G2 `pnpm validate` | Passed | `logs/validate.log`: 1,646/1,646 tests, 139 suites, zero failures, errors or warnings |
| G2 `npx eve info` | Passed | `logs/eveinfo1.log`: Eve 0.81.1, compiled manifest 54 |
| G2 `pnpm build` | Passed | Rerun with linked `.vercel/` project and `VERCEL_OIDC_TOKEN` produced 16.9 MB output; `.env.example` alone failed |
| G2 `pnpm verify:built-github` | Passed | After successful build: 31 tools across execute/inputSchema/approvalRequest/toModelOutput; allowlist, approval policies, mounted gates, native names and unstamped negative fixture all matched |
| G2 `pnpm report:capabilities` | Passed | Slack and intake-only: 55,776 characters, 36 tools, 19 skills, 2 children; repository: 81,359 characters, 40 authored tools plus 31 GitHub tools; 68.6% |
| G2 `pnpm executor:contract` | Passed | `logs/contract.log`: exit 0, shared-toolkit notes |
| C1 Seed old sessions | Passed | `dpl_8BFYawshiJfK9QLpjftBQ7jfwJWG`: Slack roots `wrun_41M5FSPFN20GH58H8Z830KP3D9` and `wrun_41M5FSPFWP0GWPQN8SWT3C5XT4`; Linear root `wrun_41M5FSV4B80GJ6J77Z2P4DFYDT` on [SAN-69](https://linear.app/acquisity/issue/SAN-69) |
| C2 Quiet ingress, inventory, drain and reset | Partial | Connector triggers paused and verified; schedule quieting not exercised (Preview runs no schedules). `trigger-readbacks.log`, `inv-0542-paused.tsv`, `reset-0542.log`: null destinations, no ingress on pause probe, drained three roots and two children, retired roots; children already cancelled |
| C3 Deploy, resume and continue | Passed | `dpl_9NAfRarnoLTpNBWr1d71BiVRr4nx`: fresh Slack sessions `wrun_41M5FTK52G0GWCGSXGWH5YVCXM` / `wrun_41M5FTK5BA0GHMQSFRD59T87WZ`, Linear `wrun_41M5FTK9JQ0GW7V2ZMS3E90SWQ`; restored visible history and provider reads; evidence below |
| C4 Rollback rehearsal | Passed | `reset-081.log`: four resets through 0.81.1; `dpl_3r22Ffp9BreNXAG8wxRpoy8H7Cej`: fresh Slack `wrun_41M5FTQK930GN97981AS3VXX95` and Linear `wrun_41M5FTQMAR0GSW0X9MENF7BT5P`, provider reads and replies; staging destinations restored |
| Master QA: widget | Pending | |
| Master QA: Linear | Pending | |
| Master QA: Slack | Pending | |
| Master QA: evals | Pending | |

## Rehearsal transcript

C1: the 0.54.2 Preview deployment `dpl_8BFYawshiJfK9QLpjftBQ7jfwJWG` at `7cd99b8` was READY at `https://foreman-kcmt5xlyp-acquisity.vercel.app`. Pushing a SHA already built for main produced no Preview deployment, so the worker created it through `POST /v13/deployments` with GitHub `gitSource` and no `target` (`target: "preview"` was rejected). [Slack thread A](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1792605370356049) launched native children `wrun_41M5FSPZTF0GVG5D3NJB7KK1TW` and `wrun_41M5FSQ0VE0GYKMMQ73ND2BJRK`; [thread B](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1792605370750889) was idle after answering 42. SAN-69 supplied the Linear root. On 0.54.2, child results started a later root turn, as expected.

C2: both connector destinations were emptied at 17:59:54Z. The thread B pause probe `1792605598.839939` produced no Preview Slack/Linear ingress, run or reply. Inventory at 18:01Z found three roots and two children. Children completed at 18:02:33Z and 18:02:35Z, thread A replied at `1792605773.240799`, and Linear completed at 18:06:34Z. Reset through the immutable 0.54.2 host returned `reset` for all three roots, `no_active_session` for the already-cancelled children, and `no_active_session` on a repeated root reset. Child timeout runs `wrun_41M5FSQ1TH0GTK4KFXFFA4BHVR` and `wrun_41M5FSQ0VV0GM9CFQZGN4NQRD8` remained running; root timeouts were cancelled. Idle waiting was the Slack parked-session stand-in.

C3: destinations moved to staging at 18:11:42Z. Eve 0.81.1 deployment `dpl_9NAfRarnoLTpNBWr1d71BiVRr4nx` at `3b23fd3` was READY at `https://foreman-8g71hdxfg-acquisity.vercel.app`. The two fresh Slack sessions in the checks table restored the earlier thread markers, dates and answer 42, and read ENG-15875/ENG-15868 through successful `executor__execute` calls. Replies were `1792606359.098869` (A) and `1792606351.858549` (B); ops alone cannot map the two session IDs to A/B because they started within one second. SAN-69 prompt `aeac603d-7a6d-44ec-8b58-cd3c7fef63f2` produced reply `e1fa5c77-e0e4-4ccf-86f7-3e02f48057a3` with restored visible history and a successful provider read. A tester's second prompt `9d130686-c656-466b-b6c4-88d180512882` created duplicate session `wrun_41M5FTKYNZ0GKS7Q51WSSX0AKC` and reply `1b4939e2-f733-4ac9-a28a-0a8b062c9d48`.

C4: all four upgraded turns drained and reset through the retained 0.81.1 host before triggers moved to the revert. Revert deployment `dpl_3r22Ffp9BreNXAG8wxRpoy8H7Cej` at `0f9dfbf` (main's tree with parent `3b23fd3`) was READY at `https://foreman-29xyysp92-acquisity.vercel.app`. Thread A continuation `1792606452.801079` started fresh session `wrun_41M5FTQK930GN97981AS3VXX95`; reply `1792606483.615519` retained visible history and the provider-read title. SAN-69 continuation `43ebc729-2ec1-4e80-bf74-f64df358677a` started `wrun_41M5FTQMAR0GSW0X9MENF7BT5P`, with successful provider read and reply `63191d2f-4126-4c0d-a19c-a2f1f11f3160`. Both revert sessions were then reset, staging destinations restored and read back, and rehearsal branches and their environment entries removed. Production/general Preview snapshot restoration was not exercised; the rehearsal branches used the old snapshot.

Observations under QA, separate from the passes: all four 0.81.1 sessions logged one `eve__search` error before an ok retry; the cause has not been read. One Slack session also logged an `executor__execute` error before success. The 0.54.2 SAN-69 run posted a "Triage investigation" comment authored as Aaron, in addition to Foreman Preview's reply; this predates the upgrade and remains under QA. The duplicate Linear session came from the tester's double prompt.

## READY deployment and commit

Rehearsal: `dpl_9NAfRarnoLTpNBWr1d71BiVRr4nx`, `https://foreman-8g71hdxfg-acquisity.vercel.app`, READY at `3b23fd3485d613322fe3a16ab893ff0abe09346e`.

Master QA runs on the final staging head after this PR merges. The rehearsal deployment is not final master QA or Production acceptance.
