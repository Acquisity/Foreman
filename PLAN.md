# Foreman local improvement plan

Goal: make Foreman complete ordinary Slack work with less waiting, fewer silent losses, and fewer human interruptions. This plan implements the Foreman-side findings from the 2026-08-29 audit of 2,270 requests. Typical response time was 48 seconds, one request in ten exceeded 6.8 minutes, and 11.2 percent of requests were cancelled by a later mention.

Audit report: https://claude.ai/code/artifact/6c91bcd2-c7bf-4661-a480-df63cfdff750

## Fixed decisions

- Work only in `/home/aaron/orca/workspaces/foreman/big-changes-but-local` on branch `afragahaha/big-changes-but-local`.
- Commit locally. Never push, open a pull request, post to Slack or Linear, switch branches, or touch `main`.
- Do not edit `node_modules/eve`. Framework changes go in the eve proposals section.
- One checklist item is one automation session. Do not combine items even when time remains.
- Kimi owns implementation. Codex is used only for the thermo-nuclear review through Orca orchestration.
- Aaron owns live Slack and `pnpm dev` verification. Lines beginning with `AV` are not automation work.

## Hourly session protocol

1. Claim the next item.
   - Run `bash scripts/plan-precheck.sh`. If it prints `skip`, stop without changes.
   - Write the current UTC time, Kimi session id, and selected item id to `$HOME/.cache/foreman-plan.lock`.
   - Read this plan item, every named file, `AGENTS.md`, and the version-matched eve guide for every eve API used.
2. Implement only the selected checklist item.
   - Preserve unrelated local changes.
   - Prefer a small canonical helper and direct tests over new condition trees.
   - Do not edit any later checkbox.
3. Verify before review.
   - Run the item-specific tests.
   - Run `pnpm fix`, then `pnpm validate`. Both must finish with zero errors and warnings.
4. Run the Codex thermo-nuclear review through Orca orchestration.
   - Load the version-matched orchestration guide with `orca-ide skills get orchestration`.
   - Create or bind a Run, create a review Task for the selected item, and start a Codex worker in the current worktree.
   - The review is read-only. Tell Codex to read `agent/skills/thermo-nuclear-code-quality-review/SKILL.md`, inspect `git diff HEAD` plus untracked files, and report blocking, high, medium, and low findings with file and line references.
   - Wait for `worker_done`, `escalation`, or `question`. Process every message, release the worker, then acknowledge the delivery.
   - Fix all blocking and high findings. Fix cheap medium findings. Run `pnpm validate` again. Run at most one additional review when fixes materially changed the design.
5. Record and commit.
   - Change only the selected line from `[ ]` to `[x]` and append `done <UTC time>, <one-sentence result>`.
   - Append one session-log line with item id, validation result, review rounds, and finding counts.
   - Commit code, tests, and this plan together with `plan(<item id>): <short result>`.
   - The commit id is recoverable with `git log --grep='plan(<item id>)'`; do not try to write a commit's own id into that commit.
6. On a real blocker.
   - Change only the selected line to `[!]` and append the concrete blocker and remaining work.
   - Commit only useful completed work and this plan when the tree still passes `pnpm validate`; otherwise revert only the session's own edits and commit the blocker note alone.
7. Remove `$HOME/.cache/foreman-plan.lock` and stop.

Hard limits: never use `git push`, `git stash`, `git reset --hard`, or destructive checkout commands. Never mark an item complete before its tests, `pnpm validate`, and Codex review pass.

## Codex review specification

Review PLAN.md item `<id>`: `<goal>`. This is a read-only review of `git diff HEAD` plus untracked files in the current worktree. Apply `agent/skills/thermo-nuclear-code-quality-review/SKILL.md` in full. Look especially for unnecessary abstractions, giant files, growing conditional branches, misplaced policy, unsafe trust or repository behavior, missing failure paths, weak tests, and violations of AGENTS.md. Confirm `pnpm validate` passes and nothing was pushed. Rank findings blocking, high, medium, or low; give `file:line`, the consequence, and a concrete correction. End with APPROVE or REJECT, then send `worker_done` with the findings.

## Checklist

### P1 Preserve follow-up Slack messages and make cancellation explicit

Outcome: later mentions wait behind the running turn. Only a message consisting of `stop` or `cancel`, with an optional bot mention and punctuation, cancels it, and Slack receives one cancellation notice.

- [x] P1.1 Add `agent/lib/slack-stop.ts` and tests for bounded literal stop/cancel detection. Accept optional Slack mentions, case, whitespace, and terminal punctuation; reject longer requests such as `stop the deploy`. This separate helper must survive P5's removal of the old reply-marker helper. Tests: focused new test file, `pnpm validate`. done 2026-08-29T16:08Z, isStopRequest matches only literal stop/cancel with edge mentions and terminal punctuation under a 200-character bound, 13 focused tests.
- [x] P1.2 Set the Slack turn policy to queue, intercept literal stop/cancel before model delivery using the version-matched channel API, and post one short line from `turn.cancelled`. Update Slack channel documentation and AGENTS.md. Tests: channel discovery, existing Slack tests, `pnpm validate`. done 2026-08-29T16:29Z, queue turn policy plus admission-first stop interception that cancels through `ctx.cancel()` and posts `Stopped.` once from `turn.cancelled`, 7 focused channel tests.
- AV P1 Slack: while one request is running, send another request and confirm it waits; send `stop` and confirm the active turn ends with one notice.

### P2 Never park a Slack turn on a sign-in prompt

Outcome: every Slack-issued user session treats a missing or expired user grant as a terminal, non-retryable connection failure that the model can work around. Connection discovery always names one connection.

- [x] P2.1 Generalize `user-connect.ts` from intake-only denial to every Slack-issued user principal, including the SLA schedule's Slack principal. Keep Linear, local eve, and app principals unchanged. Rename the denial reason and update tests, channel prose, schedule prose, and AGENTS.md. Tests: user-connect and Slack-intake suites, `pnpm validate`. done 2026-08-29T17:23Z, slackSignInDenial keys on the `slack:` principal-id prefix instead of the intake-only stamp and the reason is now `slack_sign_in_unavailable`, with Linear, local eve, and app principals untouched.
- [x] P2.2 Update every authored `connection_search` instruction to require the `connection` argument. Cover general/factory prompts, triage, billing, Intercom, critic, and SLA instructions with a source-level test. Tests: prompts and skill tests, `pnpm validate`. done 2026-08-29T19:02Z, both root prompts gained a scoped-discovery section and all seven authored instruction surfaces now require `connection` naming one connection, pinned by a new sentence-level source test with exactly one whitelisted prohibition.
- [x] P2.3 Add a small attended-only `sign_in` root tool for a person who intentionally asks to connect one service. It may invoke consent only for the known Slack-denial error and must refuse unattended sessions or unrelated errors. Tests: unattended refusal, expected consent path, unrelated error propagation, existing grant, and `eve info` discovery. done 2026-08-29T19:49Z, `sign_in` probes the connection's userConnect-wrapped auth and invokes consent through the unwrapped definition from the new `consentAuth` accessor only on the `slack_sign_in_unavailable` denial, refusing unattended and non-user sessions before any token request; 13-connection registry pinned by tests plus manifest discovery.
- AV P2 Slack: request a tool with a missing grant and confirm the turn replies with what it skipped instead of waiting on a card; intentionally request sign-in and complete it in a developer channel.

### P4 Remove the hidden 40M input-token session limit

Outcome: cached prompt re-reads cannot park a long Slack thread on eve's Approve/Stop card. Output remains on eve's existing uncapped default.

- [x] P4.1 Add `limits: { maxInputTokensPerSession: false }` to the root agent and a root-agent unit test that pins the exact limits object. Update the nearby rationale without changing other model/session settings. Tests: new root-agent test, check, typecheck. done 2026-08-29T20:13Z, root agent disables the default 40M input budget with the rationale recorded beside the setting and agent/agent.test.ts pinning the exact limits object.
- [x] P4.2 Extend the suite's existing single `eve info` run in `critic.test.ts` to read the compiled manifest and assert the root input limit is `false`. Do not add a second concurrent compiler spawn. Tests: focused critic test and full test suite. done 2026-08-29T21:09Z, the discovery test now also parses the compiled manifest from the same `eve info` spawn and pins `config.limits.maxInputTokensPerSession` to `false`, proving the source-level pin survives compilation.
- [x] P4.3 Document why the input limit is disabled in README.md and AGENTS.md, then run `pnpm validate`. done 2026-08-29T22:09Z, README gained a Session limits section and AGENTS.md an Eve conventions bullet, both explaining the 40M default, the cached re-read failure mode, and the unanswerable budget card.

### P5 Guarantee that every finished Slack reply lands

Outcome: no reply-marker path can reduce a completed message to nothing. Replies over Slack's 12,000-character markdown limit are posted as ordered chunks, and a rejected post produces a short visible fallback.

- [ ] P5.1 Remove the `---reply---` parsing contract, delete only the obsolete reply-marker helper/tests, and post the complete final model message. Preserve P1's separate stop helper. Update Slack wording instructions and ENG-13251-related prose. Tests: no `reply---` remains under `agent/`, Slack channel discovery, `pnpm validate`.
- [ ] P5.2 Add `agent/lib/slack-post.ts` with a 12,000-character chunker that prefers paragraph then line boundaries and hard-cuts only when needed. Route final replies through it. If posting fails, log the original failure and attempt exactly one short fallback naming the Slack error. Tests: short reply, paragraph/line/hard splits, content preservation, empty input, ordered posting, and rejected-post fallback; `pnpm validate`.
- AV P5 Slack: return a reply over 24,000 characters and confirm all chunks arrive in order; simulate or observe a rejected post and confirm a fallback appears.

### P6 Make Bug critic review one pass

Outcome: a Linear Bug uses the critic exactly once. Foreman adjudicates CHALLENGE, INSUFFICIENT_EVIDENCE, or critic failure and continues routing instead of re-delegating or parking on Aaron.

- [ ] P6.1 Rewrite the root triage/reporting/handoff contract for one critic delegation, one progress line, and one adjudication. Preserve the urgent-human hotlane. Put blocking findings in the ticket document's Review line. Update triage skill tests to reject attempt/re-delegation wording. Tests: focused triage tests, `pnpm validate`.
- [ ] P6.2 Remove attempt numbering and retry language from the critic's agent description, instructions, child skill, and tests. Keep the critic read-only and evidence-bound. Tests: critic and critic-capabilities suites, `pnpm validate`.
- AV P6 Linear: run one Bug investigation that the critic challenges and confirm there is one critic run and the ticket still reaches an evidence-backed route.

### P3 Reduce the triage prompt loaded before evidence

Outcome: product triage loads at most 15 KB before evidence collection and loads a separate handling skill of at most 20 KB only after Stage 4. Behavior and trust boundaries remain unchanged.

- [ ] P3.1 Move Stages 5 through 7 and report templates verbatim into a new `triage-handling` skill, update links and skill roster, and keep tests reading both halves. This is a move-only checkpoint before editing prose. Tests: triage and Slack-intake suites, `eve info`, `pnpm validate`.
- [ ] P3.2 Fold the triage tools reference into a compact exact tool-name table in the intake skill and delete the redundant reference file. Pin the full catalog in tests. Tests: triage skill tests, `pnpm validate`.
- [ ] P3.3 Trim the intake skill's introduction, rules, and Stages 1 through 4 to 15,000 bytes or less. Preserve all evidence lanes, memory rules, trust boundaries, project-independent retrieval, and the explicit handoff to `triage-handling`. Tests: relevant triage cases, byte check, `pnpm validate`.
- [ ] P3.4 Trim handling Stage 5 to roughly 9 KB without changing verdict, unblock, priority, labeling, critic, or routing semantics. Tests: all Stage 5 contract cases, `pnpm validate`.
- [ ] P3.5 Trim handling Stages 6 and 7 plus templates so the complete handling skill is at most 20,000 bytes. Give the final Slack-post rule one canonical home in `slack-intake.ts`. Tests: routing, correction, final-reply, and Slack-intake cases; `pnpm validate`.
- [ ] P3.6 Add permanent byte-budget tests for both skills and record the measured before/after totals in the session log. Tests: full `pnpm validate`.

### P7 Add long-running progress and countable operations logs

Outcome: non-intake Slack requests still running at 5 and 15 minutes post one short progress line at each threshold, and important lifecycle events emit bounded one-line JSON logs.

- [ ] P7.1 Add a pure bounded ops-log helper and an `agent/hooks/ops.ts` hook covering session/turn start and end, cancellation, step/turn/session failure, sign-in requests, and input cards. Logging must never throw or include unbounded messages. Tests: valid JSON, truncation, non-string values, logger failure, eight-event hook discovery, `pnpm validate`.
- [ ] P7.2 Add a pure Slack progress decision helper and typed channel state for start time, post count, tool-call count, and current wait label. It returns lines only at 5 and 15 minutes and never a third line. Tests: threshold boundaries and missing state, `pnpm validate`.
- [ ] P7.3 Wire progress checks into Slack lifecycle handlers without posting in intake-only sessions or duplicating final replies. Keep the channel event map small and update tests/docs. Tests: focused helpers, channel discovery, `pnpm validate`.
- AV P7 Slack: run past both thresholds and confirm exactly two progress lines; confirm an intake-only thread receives none.

### P8 Put deadlines on Foreman-owned outside calls

Outcome: Stripe/Autumn reads stop within 20 seconds, Instantly requests within 15 seconds, and repository clone/fetch/install commands within 5 minutes. Caller cancellation remains distinct from timeout.

- [ ] P8.1 Add a composed 20-second deadline to Stripe and Autumn reads. Preserve caller AbortSignal behavior and map only TimeoutError to provider-specific messages. Tests: signal attached, timeout mapping, caller cancellation unchanged, `pnpm validate`.
- [ ] P8.2 Add a 15-second deadline per Instantly HTTP request with the same timeout-versus-cancellation distinction and no retry of a hung request. Tests: signal attached, timeout, caller cancellation, pagination unchanged, `pnpm validate`.
- [ ] P8.3 Add a shared bounded sandbox-run helper or direct `timeoutMs` option, whichever the version-matched eve API supports, to repository clone, fetch/reset, and dependency install. Use 300 seconds, clean partial explicit checkouts safely, and preserve credential removal in `finally`. Tests: fake sandbox observes each timeout and failure cleanup; `pnpm validate`.
- [ ] P8.4 Audit remaining Foreman-authored `fetch` and long sandbox calls, document which already have deadlines and why any remaining call is intentionally exempt, then run `pnpm validate`. Do not widen into eve framework calls.

### P9 Allow repository switching and human branch names

Outcome: attended Slack, Linear, eve, and local sessions can replace an explicitly prepared repository; signed GitHub sessions remain bound. Any branch accepted by `validateBranch` may be pushed except protected branches. Refusals become countable warnings.

- [ ] P9.1 Remove the `foreman/` prefix policy from `push_branch`, retain `validateBranch`, protected branch refusal, and signed-webhook binding, and log every `success:false` refusal once. Tests: human feature branch accepted, main/master refused, signed repository cannot retarget, warn assertions, `pnpm validate`.
- [ ] P9.2 Let `prepare_repository` replace a different explicit repository after validating the target. Never replace a signed GitHub checkout. Gate dependency install on the relevant lockfile changing between old and new HEAD, and return both previous and current repository provenance. Tests: same-repo reuse, explicit replacement, signed refusal, lockfile unchanged/changed, cleanup on failure, `pnpm validate`.
- [ ] P9.3 Update general prompt, repository docs, architecture, investigation skills, and AGENTS.md to remove the single-repository and branch-prefix claims. Log all prepare refusals once. Tests: prompt/repository tests, `pnpm validate`.
- AV P9: in one attended thread prepare repository A then B and push a non-prefixed feature branch; confirm a signed GitHub webhook still cannot switch.

### P10 Reduce irrelevant capability catalogs without losing reachability

Outcome: ordinary conversation and triage do not pay for factory/repository capability descriptions they cannot use yet. A request that selects a repository or factory mode still gains the complete required surface before acting.

- [ ] P10.1 Build a deterministic capability-budget test/report from the compiled manifest and a representative Slack session. Record tool, skill, subagent, and schema-character totals by source. Establish tests for four lanes: ordinary Slack, intake Slack, repository-selected interactive, and autonomous factory. This item measures only and changes no runtime surface.
- [ ] P10.2 Make the factory skill absent for ordinary Slack turns and present only for explicit factory intent, an already selected repository requiring factory work, or autonomous factory authority. Keep direct work available. Use channel metadata or signed session state, not free-text repository authority. Tests: the four lane cases and `pnpm validate`.
- [ ] P10.3 Convert Foreman-authored repository tools and the GitHub extension to dynamic availability where eve 0.44 supports it: absent on ordinary/intake conversation until an explicit repository is selected, present on repository and factory lanes, and never weakened for a signed webhook. Preserve every durable GitHub callback carrier. If whole-extension or subagent removal is unsupported without changing eve, implement only the supported authored-tool subset and record the rest under eve proposals. Tests: runtime lane matrix, extension callback invariant, `eve info`, `pnpm validate`.
- [ ] P10.4 Re-run the capability budget and require a material reduction for ordinary Slack with zero loss in repository/factory lane counts. Document the before/after token estimate and all deferred framework-owned catalogs. Tests: budget regression test, `pnpm validate`.
- AV P10 Slack: ordinary conversation succeeds without repository tools; a later request with one GitHub URL can prepare and work in that repository; explicit factory mode still exposes all stations.

## Eve proposals

These are text-only follow-ups. The automation must not edit `node_modules` or an external eve checkout.

- Add a first-class per-tool timeout so connection, extension, and built-in tools can share one deadline/error contract.
- Let channel delivery failures emit a durable failure event that an authored channel hook can turn into a fallback reply.
- Let dynamic capability resolvers enable or disable whole extensions, built-in browser tools, and declared subagents by channel/session lane without copying their definitions.
- Expose prompt/tool-schema byte and cache accounting through runtime diagnostics so catalog regressions do not require trace reconstruction.

## Session log

<!-- Append one line per completed or blocked hourly session. -->

- 2026-08-29T16:08Z P1.1: validate pass (368 tests, 0 errors/warnings); Codex review rounds 2 (round 1 REJECT: 1 high, 1 medium; round 2 REJECT: 1 high, 1 medium; all four findings fixed, final validate pass; third round not run per protocol cap).
- 2026-08-29T16:29Z P1.2: validate pass (375 tests, 0 errors/warnings); Codex review rounds 1 (REJECT: 1 high; finding fixed with a no-author test added, final validate pass; second round not run because the fix was a three-line admission-order change, not a design change).
- 2026-08-29T17:23Z P2.1: validate pass (377 tests, 0 errors/warnings); Codex review rounds 1 (APPROVE: 0 blocking, 0 high, 0 medium, 0 low).
- 2026-08-29T19:02Z P2.2: validate pass (379 tests, 0 errors/warnings); Codex review rounds 2 (round 1 REJECT: 1 medium; round 2 REJECT: 1 medium; both test-guard findings fixed — exact required phrase plus full-sentence whitelist, final validate pass; third round not run per protocol cap).
- 2026-08-29T19:49Z P2.3: validate pass (388 tests, 0 errors/warnings); Codex review rounds 1 (APPROVE: 0 blocking, 0 high, 0 medium, 0 low).
- 2026-08-29T20:13Z P4.1: validate pass (389 tests, 0 errors/warnings); Codex review rounds 1 (REJECT: 1 medium — unrelated .gitignore/biome.jsonc lint-scope change inside the P4.1 delta; fixed by splitting it into its own chore commit, final validate pass; second round not run because the fix reorganized commits, not the design).
- 2026-08-29T21:09Z P4.2: validate pass (389 tests, 0 errors/warnings); Codex review rounds 1 (APPROVE: 0 blocking, 0 high, 0 medium, 0 low). Worker start initially blocked on Codex's hooks trust prompt; resolved by trusting Orca's hooks in the terminal and reusing it.
- 2026-08-29T22:09Z P4.3: validate pass (389 tests, 0 errors/warnings); Codex review rounds 1 (APPROVE: 0 blocking, 0 high, 0 medium, 0 low). Same hooks trust prompt as P4.2; resolved the same way and retried the dispatch with --retry-of after the failed start marked the task failed. Validate needs .env plus .env.local sourced for the connector UIDs eve info evaluates.
