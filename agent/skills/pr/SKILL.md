---
description: "Commit, push, and open or update a pull request for the current Git repository. Use this skill whenever the user asks to make or open a PR, says \"ship this\", \"commit and push\", \"push these changes\", or wants the current work published. Handles detached HEAD checkouts, existing branches, and existing PRs; new PRs are created as drafts with direct titles."
---

# PR

Use this skill to turn the current repository state into a pushed branch and, when appropriate, a pull request.

The user wants a practical shipping workflow, not a long planning exercise. Inspect the repo, make conservative branch/base decisions, commit the intended changes, push, and create or update the PR.

## Core Rules

- Create new PRs as drafts by default. Mark a PR ready for review only when the user explicitly asks.
- Never merge a PR. Opening, updating, and marking ready are the only GitHub PR actions this skill performs.
- Do not use a pull request template. Write a plain, direct body.
- Keep PR titles and bodies direct and descriptive. Avoid inflated language, vague claims, and big abstract wording.
- Use concise, plain titles. Do not use conventional-commit prefixes such as `fix:`, `feat:`, or `chore:`.
- Do not create duplicate PRs. If an open PR already exists for the branch, commit and push new changes to that PR.
- Do not use destructive git commands such as `git reset --hard`, force push, or checkout over local changes unless the user explicitly asked for that exact operation.

## Step 1: Inspect State

Run the bundled context script first when available:

```bash
bash .agents/skills/pr/scripts/pr-context.sh
```

If the skill is being run outside the repository root, compute the skill directory at runtime and run `pr-context.sh` from `$SKILL_DIR/scripts/pr-context.sh`.

Note: `pr-context.sh` is copied verbatim from the source skill. Its `gh`-dependent default-branch and open-PR detection no-ops in Foreman (no `gh` CLI); use `github__getPullRequestContext` and `github__listPullRequests` instead.

Then inspect enough local state to understand what will be committed:

```bash
git status --short --branch
git diff --stat
git diff --cached --stat
git log --oneline -5
```

Also check the default branch and existing PRs with `github__getPullRequestContext` and `github__listPullRequests`.

## Step 2: Decide The Branch

If HEAD is detached:

1. Create a new branch from the current commit.
2. Choose a short branch name from the actual change: `foreman/<plain-slug>`.
3. If the name already exists, append the short SHA.

Example:

```bash
git switch -c foreman/crm-deal-filter-uuid-guards
```

If already on a branch:

- Keep the branch unless it is the default branch.
- If currently on `main` or the repo's default branch, create a new branch before committing.
- Preserve the existing branch name when pushing more work to an existing PR.

## Step 3: Decide The PR Base

Default to the repo default branch, usually `main`.

Use a non-main base only when the current branch is clearly based on another branch that is not yet merged into `main`. If the base is ambiguous, ask one concise question before creating the PR. Do not guess a PR base when the wrong base would create reviewer noise.

State the chosen base in the final response.

## Step 4: Stage And Commit

Stage the intended changes. If the working tree contains unrelated files that are not part of the user's current request, leave them unstaged and mention them. If you cannot separate intended from unrelated changes, ask before committing.

Use a concise commit message. The message should say what changed, not oversell why it is impressive.

Examples:

```bash
git add AGENTS.md ENV_README.md
git commit -m "document production migration database permissions"
```

If there are no local changes:

- If an open PR already exists, report that there is nothing new to push.
- If the branch has unpushed commits and no PR, continue to push/open a PR.
- If there are no local changes and no unpushed commits, stop and explain that there is nothing to ship.

## Step 5: Validate

Run focused validation that fits the change. Keep it proportional:

- Docs-only: no tests required; say that it was docs-only.
- Single frontend/backend change: run the nearest focused test, typecheck, or lint command if practical.
- Broad or risky change: run the repo's standard checks or explain why they were skipped.

Do not hide skipped validation. Put it in the PR body and final response.

## Step 6: Push

Push the branch with the `push_branch` tool, passing the branch name. Do not use `git push` directly.

## Step 7: Open Or Update The PR

Check for an existing open PR after pushing with `github__listPullRequests`.

If an open PR exists:

- Do not create another PR.
- If you committed new changes, pushing is enough.
- If the existing PR is a draft and the user explicitly asked to ship, mark it ready with `github__updatePullRequest`.

If no open PR exists, create one with `github__createPullRequest`, passing the base, head branch, a direct title, and the body. Create it as a draft by default.

## PR Body

Write a plain body with these sections:

- What: one or two concrete sentences on what changed.
- Why: the reason for the change.
- How tested: commands run and anything intentionally skipped.
- How to QA: practical steps, or `N/A - docs/config only`.

Title examples:

- Good: `Guard UUID deal filters`
- Good: `Document production migration database permissions`
- Good: `Add attendee email filter`
- Avoid: `Massive improvements to production stability`
- Avoid: `Enhance system robustness and developer velocity`

## Final Response

Keep the final response short and include:

- Branch name.
- Commit SHA and message.
- PR URL, or the existing PR URL updated.
- PR base branch.
- Validation run or skipped.
- Any files intentionally left uncommitted.
