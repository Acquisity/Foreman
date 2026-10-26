#!/usr/bin/env bash
# Puts a commit on the stable QA branch, waits for its Foreman Preview to be
# READY, and prints the deployment id. The branch alias
# foreman-git-qa-foreman-preview-acquisity.vercel.app then serves that commit.
#
# Usage: scripts/qa-preview-push.sh [commit]   (default HEAD)
set -euo pipefail

sha=$(git rev-parse "${1:-HEAD}^{commit}")
branch=${QA_PREVIEW_BRANCH:-qa/foreman-preview}
query="projectId=prj_zeRzl67zpLpS6pXjscNusD3Gc307&teamId=team_ZU8UTsvGgsLZaLDc8pUAzict&target=preview&limit=50"

git push origin "$sha:refs/heads/$branch" --force

for _ in $(seq 90); do
  found=$(npx vercel api "/v6/deployments?$query" --scope acquisity |
    sed '/^$/d' |
    jq -r --arg sha "$sha" --arg branch "$branch" \
      'first(.deployments[] | select(.meta.githubCommitSha == $sha and .meta.githubCommitRef == $branch) | "\(.uid) \(.state)") // ""')
  case $found in
  *" READY")
    echo "${found% *}"
    exit 0
    ;;
  *" ERROR" | *" CANCELED")
    echo "Preview deployment failed: $found" >&2
    exit 1
    ;;
  esac
  sleep 10
done
echo "No READY Preview deployment for $sha on $branch after 15 minutes." >&2
exit 1
