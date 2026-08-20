# GitHub Review API Notes (Foreman)

Foreman talks to GitHub through the `github__*` eve extension. There is no GitHub CLI, no Firewatch, and no JSON filtering utility in this environment.

## Available Tools

- `github__getPullRequestContext` — returns PR metadata: number, URL, title, head and base branch, repository, author, and related state. Use this to resolve the target PR.
- `github__listPullRequestReviews` — returns review bodies only: `{ id, state, body, author, url, submittedAt }`. It does not return inline review comments. Use this to read top-level review summaries.
- `github__listIssueComments` — returns PR-level issue comments, including bot summaries and release notes. Use this to catch bot feedback posted outside review threads. Bodies are truncated to ~500 chars by default, so pass `detail: 'full'` to read complete findings.
- `github__listPullRequestFiles` — returns the changed files and diff context for the PR. Use this to locate the code around a referenced line.
- `github__addPullRequestComment` — posts a PR-level comment. This is the only reply path.
- `github__listCheckRuns` / `github__getCiFailureContext` — return CI status and failure context for verification.
- `github__createPullRequest` / `github__updatePullRequest` / `github__listPullRequests` — PR lifecycle tools (used by the `pr` skill, not this loop).

## Bot Identification

The in-scope allowlist is environment-driven. `FOREMAN_REVIEW_BOT_LOGINS` is a comma-separated list of lowercase GitHub logins, default empty, which the host injects into the prompt; it is not readable from the sandbox. A comment is in scope only when its author login (lowercased) is in that list.

Common bots to configure: CodeRabbit (`coderabbitai`, `coderabbitai[bot]`), Cubic (`cubic-dev-ai`, `cubic-dev-ai[bot]`), Devin (`devin-ai-integration`, `devin-ai-integration[bot]`, `devin[bot]`), and React Doctor (`github-actions[bot]` only when the body contains a React Doctor marker).

## Reply Path

All replies go through `github__addPullRequestComment` as PR-level comments. There is no reply-to-review-comment tool, so replies cannot be attached to a specific inline thread.

## State File Convention

Dedupe processed comments with `.context/review-bot-loop-state.json`. Store at least the comment ID and `updatedAt`. A comment is already handled when its ID is recorded and its `updatedAt` is unchanged; reprocess when the comment is new or its `updatedAt` changed.

## Gaps

- No inline review comments: `github__listPullRequestReviews` returns review bodies only, and no tool reads `pulls/comments`, so inline review comments are invisible.
- No reply-to-review-comment tool: replies are PR-level only.
- No `resolveReviewThread` tool: inline-thread resolution requires a human or a future tool.
