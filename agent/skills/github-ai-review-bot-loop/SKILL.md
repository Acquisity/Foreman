---
description: "Watch a GitHub PR for AI code-review comments from bots configured in FOREMAN_REVIEW_BOT_LOGINS; critically fix or rebut each one; commit and push atomic fixes; reply at the PR level; and keep polling until a clean window is reached. Use when the user asks to monitor, babysit, triage, handle, fix, reject, reply to, or resolve AI review-bot feedback on the current branch's PR."
---

# GitHub AI Review Bot Loop

Use this skill to process incoming GitHub PR review feedback from in-scope AI review bots. The goal is to keep the PR branch moving while avoiding mechanical acceptance of bad bot suggestions.

This is more automated than a normal review-follow-up pass:

- Poll for new live AI bot comments until a clean window elapses.
- Use the `github__*` tools for fetching and writing.
- Delegate each live thread or PR-level comment to a focused worker when sub-agents are available.
- Decide whether the bot is right before editing code.
- If the comment is valid, implement the smallest correct fix, verify it, make one atomic commit for that comment, push immediately, and reply with the commit.
- If the comment is wrong or out of scope, reply with the technical reason and leave the thread unresolved for human visibility.

## Invocation

Invoke this skill explicitly by naming it in the prompt:

```text
Use the github-ai-review-bot-loop skill on the current PR.
```

Use read-only wording when no GitHub writes are intended:

```text
Use the github-ai-review-bot-loop skill to fetch and classify AI bot comments, no replies or resolves.
```

## Default Assumptions

- The current checkout is on the PR branch unless the user provides a PR URL or number.
- Poll every 60 seconds when the user asks to monitor or keep watching.
- If the user does not specify a clean-window duration, use 10 minutes measured from the later of the last push or last GitHub write.
- Only review feedback from bots in `FOREMAN_REVIEW_BOT_LOGINS` is in scope by default. Do not resolve human review comments or unrelated bot comments.
- GitHub writes are allowed only when the user asked to handle, fix, reject, reply, resolve, or run the loop. For read-only requests, fetch and classify but stop before replies, resolution, commits, or pushes.

## Required Tools

- `bash` for local git commands
- `push_branch` for pushing the branch
- `github__getPullRequestContext` for PR metadata
- `github__listPullRequestReviews` for review bodies
- `github__listIssueComments` for PR-level issue comments (pass `detail: 'full'` for complete bodies)
- `github__listPullRequestFiles` for changed files and diff context
- `github__addPullRequestComment` for PR-level replies
- `github__listCheckRuns` and `github__getCiFailureContext` for verification context
- Sub-agent tooling when available

If GitHub access fails, report that as the blocker. Do not claim comments were replied to or resolved unless the GitHub write actually succeeded.

## Workflow

### 1. Resolve The Target PR

Start from local context:

```bash
git status --short --branch
git remote get-url origin
```

Then fetch PR metadata with `github__getPullRequestContext`.

If the branch is not attached to a PR, ask for the PR URL or number. Do not guess.

Record:

- repository owner/name
- PR number and URL
- head branch
- base branch
- whether the current checkout has unrelated dirty files

### 2. Fetch Review Feedback

Use the `github__*` tools consistently for reads and writes during a loop iteration:

- `github__getPullRequestContext` for PR metadata and state.
- `github__listPullRequestReviews` for review bodies (state, body, author, submittedAt). It does not return inline review comments.
- `github__listIssueComments` for PR-level issue comments, including bot summaries and release notes. This is where most bot findings land. Bodies are truncated to ~500 chars by default, so pass `detail: 'full'` to read complete findings.
- `github__listPullRequestFiles` for changed files and diff context.

Fetch all pages of reviews and issue comments before deciding the PR is clean. Inline review comments are not fetchable; there is no tool that reads `pulls/comments`.

### 3. Identify In-Scope AI Bot Comments

The in-scope bot allowlist is environment-driven, not hardcoded. It is the `FOREMAN_REVIEW_BOT_LOGINS` set (comma-separated lowercase GitHub logins, default empty), which the host injects into the prompt; it is not readable from the sandbox. Only comments whose author login (lowercased) is in that set are in scope.

Common bots to configure in `FOREMAN_REVIEW_BOT_LOGINS`:

- CodeRabbit: `coderabbitai`, `coderabbitai[bot]`
- Cubic: `cubic-dev-ai`, `cubic-dev-ai[bot]`
- Devin: `devin-ai-integration`, `devin-ai-integration[bot]`, `devin[bot]`
- React Doctor: `github-actions[bot]` only when the body contains a React Doctor marker such as `React Doctor`, `react-doctor`, `millionco/react-doctor`, or `react-doctor/`

Humans, CI status comments, dependency bots, deployment bots, coverage reports, and unrelated `github-actions[bot]` comments are out of scope by default. Do not silently expand the loop scope beyond `FOREMAN_REVIEW_BOT_LOGINS`.


### 4. Skip Already Answered Comments

Foreman has no self-login lookup and no inline-thread resolution tool, so dedupe with local state. Use `.context/review-bot-loop-state.json` to remember processed comment IDs and `updatedAt` values. A comment is already handled when its ID is recorded and its `updatedAt` is unchanged.

Do not reprocess a handled comment unless its `updatedAt` changes. Because Foreman cannot read or set review-thread resolution state, a fixed, duplicate, or stale finding stays marked handled in local state and is left for a human to resolve; there is no resolve-retry loop.

The state file is local bookkeeping and must never be staged or committed.

### 5. Build A Finding Packet

For each live in-scope review body or PR-level comment, build a compact packet:

- comment or review ID
- comment URL
- author and created/updated time
- full body
- the changed files and diff context from `github__listPullRequestFiles`
- relevant tests or nearby validation commands
- current branch and dirty-file status

The packet should be enough for a worker to decide without refetching the whole PR.

### 6. Handle PR-Level Comments

Review bodies and PR-level comments carry the findings; Foreman cannot read inline review comments or thread resolution state. Bot summaries and release notes may contain actionable findings.

For each in-scope PR-level comment:

1. Extract the actionable findings.
2. Critically classify each finding.
3. Fix valid findings with atomic commits when practical.
4. Rebut incorrect or out-of-scope findings with concise evidence.
5. Post one PR comment summarizing per-finding outcomes with `github__addPullRequestComment`.
6. Record the processed comment ID and `updatedAt` in `.context/review-bot-loop-state.json`.

Do not attempt to resolve PR-level comments. Their deduplication is local state, not GitHub thread resolution.

### 7. Use A Worker Per Finding

When sub-agent tooling is available, hand one packet at a time to a worker. Process write-capable workers sequentially on the same PR branch to avoid conflicting commits. It is fine to run read-only classification workers in parallel, then apply/reply sequentially.

Use this worker contract:

```text
You own one GitHub AI review bot comment.

Inputs:
- PR URL, repository, branch, and base branch
- Finding packet with ID, URL, body, and current code context
- A writes_allowed flag: true only when the user asked to handle, fix, reject, reply, resolve, or run the loop; false for read-only runs
- Current dirty-worktree constraints

Decide critically whether the bot suggestion is valid.

Classify as one of:
- valid_fix
- valid_partial
- reject_incorrect
- reject_scope
- duplicate
- stale_or_outdated
- needs_human

When writes_allowed is false, classify and return the decision without committing, pushing, or replying.

If valid_fix or valid_partial:
1. Create a mini plan.
2. Make the smallest correct code change.
3. Add or update focused tests when the behavior is testable.
4. Run focused checks only, using the target repository's own scripts (its lint command on changed files and its test command for the nearest test), or the local check that directly covers the edit.
5. Capture the pre-edit diff, then stage only the generated patch. If a target file already has pre-existing changes, stop instead of staging the whole file. Commit only this comment's changes with a concise commit message.
6. Push to the PR branch immediately with push_branch.
7. Reply with the short commit SHA and what changed.
8. Inline-thread resolution is not available in Foreman; leave the thread for a human or a future tool. Do not resolve PR-level comments because they have no resolution state.

If reject_incorrect or reject_scope:
1. Verify against current code before rejecting.
2. Post a concise technical reply explaining why no code change is being made.
3. Do not resolve the thread.
4. Record the thread or PR-level comment as handled.

If duplicate:
1. Confirm the shared fix or prior reply covers this comment.
2. Reply with the reference when useful.
3. Leave resolution to a human or a future tool; leave disagreement-only duplicates unresolved.

If stale_or_outdated:
1. Confirm current code or a later commit already addresses the issue.
2. Reply with the commit or code evidence when useful.
3. Leave resolution to a human or a future tool.

If needs_human:
1. Do not edit, reply, or resolve unless the user asked for a best-effort call.
2. Return the exact question for the main agent or user.

Return a summary with decision, files changed, commit hash, push status, reply status, verification, and residual risk.
```

If no sub-agent tool exists, do the same workflow inline and say that the sub-agent step was unavailable.

### 8. Make The Decision Evidence-Based

Do not accept a bot comment because it is confidently worded. Check the actual code path, surrounding tests, framework behavior, and product requirements.

Use these decision rules:

- Fix real correctness, security, data-loss, authorization, accessibility, performance, type-safety, and migration-safety issues.
- Reject suggestions that contradict the current API contract, ignore tenancy or permissions, regress required behavior, duplicate existing safeguards, or propose broad refactors unrelated to the PR.
- Partially fix when the bug is real but the bot's exact patch is wrong.
- Mark stale when a later commit or current code already makes the thread obsolete.

Per atomic commit run focused checks only, using the target repository's own package manager and scripts (check `read_repository_knowledge` or the repo's package.json rather than assuming pnpm). Run the repo's full typecheck once per loop iteration before declaring the iteration clean, not after every commit. Never commit unrelated dirty files.

### 9. GitHub Writes

Replies are PR-level via `github__addPullRequestComment`. Foreman has no `resolveReviewThread` tool and no reply-to-review-comment tool, so:

- All replies are posted as PR-level comments.
- Inline-thread resolution requires a human or a future tool; this skill cannot resolve threads.

For fixed inline comments:

```text
Fixed in `<short-sha>` by moving the authorization check before the write path and adding coverage for the denied case.
```

For disagreements:

```text
I checked `<path>` and am not applying this suggestion. The existing guard runs before `<operation>`, so the proposed extra check would be redundant and would not change the failure mode. No code change here.
```

Do not resolve disagreement threads.

### 10. Polling Loop

For monitor mode:

1. Initialize the last-activity timestamp to the current time for this invocation.
2. Fetch live in-scope AI bot feedback.
3. Process all actionable threads and PR-level comments.
4. Refresh PR state after every push or GitHub write.
5. Run the target repository's typecheck once for the iteration when code changed or before declaring the iteration clean.
6. Update the last-activity timestamp after every push or GitHub write.
7. Sleep 60 seconds.
8. Reset the clean-window timer whenever a new live in-scope bot comment appears.
9. Stop when the 10-minute clean window, or the user-specified clean window, elapses with no new live in-scope bot comments, or when the user stops the run.

The clean window is measured from the last-activity timestamp. If new comments arrive while fixes are being pushed, prioritize the refreshed state over earlier packets.

### 11. Final Response

End with:

- PR URL and branch
- polling duration and final clean-window status
- number of AI bot comments handled
- fixed comments with commit hashes
- rejected comments with reply summaries and unresolved status
- PR-level comments processed and state-file entries updated
- unresolved or needs-human comments
- verification commands and results
- whether the final refresh shows zero new live in-scope AI bot comments

## Common Pitfalls

- Do not use flat PR comments as the source of truth for inline review state.
- Do not treat all `github-actions[bot]` comments as React Doctor.
- Do not let multiple write-capable workers commit to the same branch at the same time.
- Do not stage unrelated user changes.
- Do not silently ignore top-level AI review bodies; some bots put actionable comments there instead of inline threads.
- Do not auto-resolve human comments just because they are in a bot-started thread.
- Do not claim a thread was resolved; Foreman has no thread-resolution tool.
