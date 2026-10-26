#!/usr/bin/env bash
# Puts a commit on the stable QA branch, waits for its Foreman Preview to be
# READY, and prints the deployment id. The branch alias
# foreman-git-qa-foreman-preview-acquisity.vercel.app then serves that commit.
#
# A push of a commit Vercel already built for another branch starts no build,
# so when none appears within a minute the script asks Vercel for one.
#
# Usage: scripts/qa-preview-push.sh [commit]   (default HEAD)
set -euo pipefail

sha=$(git rev-parse "${1:-HEAD}^{commit}")
branch=${QA_PREVIEW_BRANCH:-qa/foreman-preview}
team=team_ZU8UTsvGgsLZaLDc8pUAzict
project=prj_zeRzl67zpLpS6pXjscNusD3Gc307
query="projectId=$project&teamId=$team&target=preview&limit=50"

git push origin "$sha:refs/heads/$branch" --force

for attempt in $(seq 90); do
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
  if [ -z "$found" ] && [ "$attempt" -eq 6 ]; then
    jq -n --arg project "$project" --arg ref "$branch" --arg sha "$sha" \
      '{name: "foreman", project: $project, gitSource: {type: "github", org: "Acquisity", repo: "Foreman", ref: $ref, sha: $sha}}' |
      npx vercel api "/v13/deployments?teamId=$team" --scope acquisity -X POST \
        -H "Content-Type: application/json" --input - --raw >/dev/null
  fi
  sleep 10
done
echo "No READY Preview deployment for $sha on $branch after 15 minutes." >&2
exit 1
