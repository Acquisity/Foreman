---
description: "Review GitHub Actions and automation PRs for workflow security, least-privilege permissions, PR trigger safety, secret exposure, third-party actions, script injection, caches/artifacts, and self-hosted runner risk. Use when reviewing another repository's CI, workflow, or automation changes; Foreman itself has no .github/workflows today, so this skill is for reviewing Actions in repositories being worked on."
---

# Foreman GitHub Actions Review

Review changed CI, workflow, and repository automation files for concrete workflow compromise or secret exposure risk. This skill reviews GitHub Actions in the repository under review, not Foreman's own CI (Foreman has no `.github/workflows` today).

## File Map

- Workflows: `.github/workflows/**/*.yml`, `.github/workflows/**/*.yaml`
- Actions: `.github/actions/**/*.yml`, `.github/actions/**/*.yaml`, `action.yml`, `action.yaml`
- GitHub scripts: `.github/scripts/**`
- Repo automation config referenced by workflows.

## Review Checklist

- `pull_request_target` is not combined with fork-controlled checkout, scripts, caches, or package installs.
- PR/comment/issue-triggered workflows do not execute untrusted branch content with write tokens or secrets.
- `permissions` are explicit and least-privilege per job. Avoid broad `contents: write`, `actions: write`, `id-token: write`, or `pull-requests: write` unless needed.
- Secrets are not exposed to fork PR code, shell output, artifacts, cache keys, PR comments, logs, or generated files.
- Shell commands quote GitHub context, PR titles/bodies/comments/labels, branch names, file paths, and workflow inputs before execution.
- Third-party actions are pinned consistently with repo policy or at least to stable versions; mutable `@latest` use is justified or avoided.
- Artifact and cache restore paths cannot overwrite scripts/config used later by privileged steps.
- Self-hosted or custom runners are not used for untrusted PR execution unless isolation is explicit.
- `workflow_dispatch`, `workflow_call`, and issue-comment commands validate inputs and restrict who can trigger privileged operations.
- Checkout ref and fetch-depth are appropriate for the operation and do not accidentally run base code when reviewing head changes.

## Severity Guidance

- High: changed workflow can expose secrets, run attacker-controlled code with write privileges, or compromise a privileged runner.
- Medium: injection, broad permissions, mutable action, or artifact/cache risk with plausible exploitation.
- Low/info: least-privilege or pinning improvement with concrete workflow relevance.

## False-Positive Controls

- Do not report broad permissions if the exact privileged API is required and limited to trusted events.
- Do not flag existing repo-wide unpinned actions unless the PR introduces or worsens them.
- Do not require secrets for eve, ultracite, or GitHub tokens brokered by Vercel Connect to be absent from env when the workflow needs them and PR trigger safety is sound.

## Output Format

For each finding include severity, workflow/job/step, attacker-controlled input or privilege boundary, exploit path, and a focused YAML/script fix.
