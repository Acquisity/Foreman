#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  echo "error=not-a-git-repository"
  exit 1
fi

cd "$repo_root"

branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
sha="$(git rev-parse --short HEAD)"
default_branch="${DEFAULT_BRANCH:-main}"

remote_default="origin/$default_branch"
git fetch --quiet origin "$default_branch" 2>/dev/null || true

echo "repo_root=$repo_root"
echo "current_sha=$sha"
echo "default_branch=$default_branch"

if [[ -z "$branch" ]]; then
  echo "detached=true"
  echo "branch="
else
  echo "detached=false"
  echo "branch=$branch"
fi

echo "status_start"
git status --short --branch
echo "status_end"

probable_base="$default_branch"

if [[ -n "$branch" ]] && git rev-parse --verify "$remote_default" >/dev/null 2>&1; then
  best_ref=""
  best_ts=0
  current_remote="origin/$branch"

  while IFS=$'\t' read -r ref_name ref_sha ref_ts; do
    [[ "$ref_name" == "origin/HEAD" ]] && continue
    [[ "$ref_name" == "$remote_default" ]] && continue
    [[ "$ref_name" == "$current_remote" ]] && continue

    if git merge-base --is-ancestor "$ref_sha" HEAD 2>/dev/null &&
      ! git merge-base --is-ancestor "$ref_sha" "$remote_default" 2>/dev/null; then
      if [[ "$ref_ts" =~ ^[0-9]+$ && "$ref_ts" -gt "$best_ts" ]]; then
        best_ref="$ref_name"
        best_ts="$ref_ts"
      fi
    fi
  done < <(git for-each-ref --format='%(refname:short)%09%(objectname)%09%(committerdate:unix)' refs/remotes/origin)

  if [[ -n "$best_ref" ]]; then
    probable_base="${best_ref#origin/}"
  fi
fi

echo "probable_base=$probable_base"
