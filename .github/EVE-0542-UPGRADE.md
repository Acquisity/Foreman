# Eve 0.54.2 upgrade evidence and acceptance

[ENG-13737](https://linear.app/acquisity/issue/ENG-13737/upgrade-core-foreman-to-eve-0542) upgrades the simplified Foreman to Eve 0.54.2, AI SDK 7.0.97 and GitHub extension 0.7.1. This records implementation evidence gathered on 2026-09-12. It is not Production acceptance. Commit SHA, PR, Preview deployment and live session references remain pending.

## Local evidence

| Check | Status | Evidence and limit |
| --- | --- | --- |
| Browser source rebuild | Passed | Unchanged upstream browser 0.37.1 source rebuilt against the target dependencies; build, typecheck and all 42 upstream tests passed. See [rebuild provenance](./EVE-BROWSER-REBUILD.md). Controlled sandbox tests do not establish deployed browser operation. |
| Fresh frozen installation | Passed | Node 24.13.0 and pnpm 11.1.3, using a fresh package store: 168 packages downloaded, zero reused. The exact-version patch applied; browser manifest reports Eve 0.54.2 and tool contract 35. All 21 tool modules, package imports and rebuilt distribution hashes were checked. |
| Server build | Passed | The target dependency set builds the Foreman server. |
| Built GitHub proof | Passed | The booted server's registered compiled module map admitted the exact 31-tool allowlist. All 31 execute, approvalRequest and toModelOutput callbacks validated. Mounted lane gates and distinct approval policies passed; the unstamped negative fixture was rejected. |
| Capability report | Passed | Manifest version 48 and compiled ownership identify framework defaults separately. Actual prepared child tools are measured; the three-lane results appear below. |
| Support unit tests | Passed | All 53 support tests passed, including cross-turn step accounting, retry deduplication, child ownership and input/authorization denial. |
| Support SQL harness | Passed | Real PostgreSQL 18.6 through the existing harness in a dedicated WSL Docker container, bound to loopback and using only `foreman_support_test`. Verified expired-lease notices, next-check retry, repeated-notice suppression, root/terminal failures, child non-ownership, pending-outbox precedence, lost Slack receipts and quiet reclaimed follow-ups. The disposable container was removed. No schema migration was added. |
| Full `pnpm validate` | Passed | Zero lint/type errors or warnings; 723 tests in 95 suites passed, with zero failures, cancellations or skips. Unchanged skill documents were restored to exact Git LF bytes after Windows checkout line endings caused five initial fixture failures; no skill content changed. |
| Fast evals | Passed | All 9 fast evals passed after the GitHub namespace fix and explicit repository-write fixture. The separate native-delegation rerun passed all 53 assertions, including two distinct children, successful actual bash results and the later combined parent answer. Local Executor access returned environment-denied because the Preview connector is not attached to development; deployed provider validation remains required. |
| Native delegation eval | Passed | Final native-only run passed 53/53 assertions in 23.3 seconds on the retained local server. Receipt and later invocation correlation, both computed child results, and later parent delivery were observed. The CLI emits an upstream Node DEP0190 warning when resolving a URL target; full pnpm validate has zero warnings. |
| Executor toolkit metadata | Passed | Both live toolkit metadata audits reported zero issues. This does not prove provider grants or a provider read through the deployed bot. |

| Lane | Catalog characters | Authored tools | Browser tools | GitHub tools | Declared children | Skills |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Slack and intake-only Slack | 57,108 | 29 | 21 | 0 | 2 | 18 |
| Repository interactive | 81,676 | 33 | 21 | 31 | 2 | 18 |

Ordinary Slack carries 69.9% of the repository catalog, below the 75% limit. Framework-owned tools, including native `agent`, remain outside these counts. The two declared children are critic and vision.

The strengthened compiled lifecycle test and live fast run found that Eve 0.54.2 leaves directory override tools without an extension namespace. The forwarding gate now qualifies map keys while preserving upstream tool definitions and callbacks. A fresh build, strengthened native-dispatch proof and report passed after the fix, including all 31 exact model-visible github__ names.

Interrupted local eval cleanup used the public task-inclusive cancel endpoint for exact roots. Both native task workflows and their two child computations settled, followed by the parent continuation; they completed during host resume, so this proves settlement rather than child cancellation. No internal storage edits or resets were used. Literal stop and cancellation during active child work remain Preview UAT gates.

## Preview setup and acceptance

The branch is `codex/eng-13737-eve-0542`. It has no remote branch at this checkpoint, so branch-scoped Vercel configuration awaits the validated commit and push. Configuration inspection verified Preview connector UIDs `slack/foreman-preview` and `executor.acquisity.ai/foreman-preview`. The existing Preview Slack trigger still targets `codex/eng-13736-remove-factory`; retargeting and branch-scoped configuration remain pending. No external configuration changes have been applied for this checkpoint.

The inspected database URL is shared by Production and Preview. Keep both support enable flags false on Preview until a separate private database and queue are configured and migrated. Preview bot routing does not isolate the scheduled support Slack destination.

- [ ] Record the final validation and fast-eval results, then commit, push and record the exact SHA and PR.
- [ ] Recheck the official browser release. Use a compatible official version when it passes the same checks; otherwise retain the documented temporary patch and its explicit removal requirement.
- [ ] Retarget the verified Preview Slack connector and remove its previous trigger branch. Set verified branch-scoped Executor settings and complete operation bindings, then redeploy and confirm the exact SHA.
- [ ] Prove an actual provider read through the deployed root and delegated paths. Metadata checks alone do not close this item.
- [ ] Verify scratch repository access and obtain any required GitHub App permission approval before dependent delivery tests. The private [scratch fixture](https://github.com/Acquisity/foreman-eve-0542-smoke) exists on main at a044031e2d544e4175ab6000ba0155e82ac5eabe. App installation 153736214 uses selected repositories and lacks statuses:read; approval requested.
- [ ] Run the complete [UAT battery](./UAT-BATTERY.md), including later child results, queue/stop behavior, critic, images, intake restrictions, scratch delivery, Slack history recovery and browser use in warm and cold sandboxes. All live Preview UAT remains pending.
- [ ] Run scheduled-support acceptance only with isolated Preview storage, selected synthetic conversations, the actual scheduled identity and a verified fixed Slack destination.
- [ ] Record deployment IDs, session IDs, Slack/test links and observed action results for every live case. Keep failed, skipped and unavailable checks outstanding.

## Cutover and rollback gates

Rehearse the version-transition procedure in [UAT-BATTERY.md](./UAT-BATTERY.md#eve-0542-cutover-and-rollback-rehearsal). Connector pause/resume control and a complete inventory of active and parked old sessions must be verified before Production acceptance. Drain work before retiring internal sessions; keep the Slack threads and recover only bounded visible history.

Retain the Eve 0.54.2 deployment URL as the reset control point. During rollback, upgraded sessions must be reset through that deployment before the main revert is deployed; Eve 0.44 cannot reset the newer driver. A code revert does not restore hidden session state. Production merge and cutover still require Aaron's acceptance and explicit merge approval.
