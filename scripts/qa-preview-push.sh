#!/usr/bin/env bash
# Puts a commit on the stable QA branch, waits until the branch alias
# foreman-git-qa-foreman-preview-acquisity.vercel.app serves it READY, and
# prints that deployment's id.
#
# A push of a commit Vercel already built starts no build, so when no new
# deployment for it appears within a minute the script asks Vercel for one.
#
# Usage: scripts/qa-preview-push.sh [commit]   (default HEAD)
set -euo pipefail

sha=$(git rev-parse "${1:-HEAD}^{commit}")
branch=${QA_PREVIEW_BRANCH:-qa/foreman-preview}
alias="foreman-git-${branch//\//-}-acquisity.vercel.app"
team=team_ZU8UTsvGgsLZaLDc8pUAzict
project=prj_zeRzl67zpLpS6pXjscNusD3Gc307
api() { npx vercel api "$@" --scope acquisity | sed '/^$/d'; }

# A minute early absorbs clock skew between this machine and Vercel.
since=$((($(date +%s) - 60) * 1000))
git push origin "$sha:refs/heads/$branch" --force

for attempt in $(seq 90); do
  served=$(api "/v13/deployments/$alias?teamId=$team" |
    jq -r '"\(.id) \(.readyState) \(.meta.githubCommitSha)"')
  if [ "${served#* }" = "READY $sha" ]; then
    echo "${served%% *}"
    exit 0
  fi
  latest=$(api "/v6/deployments?projectId=$project&teamId=$team&target=preview&since=$since&limit=50" |
    jq -r --arg sha "$sha" --arg branch "$branch" \
      'first(.deployments[] | select(.meta.githubCommitSha == $sha and .meta.githubCommitRef == $branch) | "\(.uid) \(.state)") // ""')
  case $latest in
  *" ERROR" | *" CANCELED")
    echo "Preview deployment failed: $latest" >&2
    exit 1
    ;;
  esac
  if [ -z "$latest" ] && [ "$attempt" -eq 6 ]; then
    jq -n --arg project "$project" --arg ref "$branch" --arg sha "$sha" \
      '{name: "foreman", project: $project, gitSource: {type: "github", org: "Acquisity", repo: "Foreman", ref: $ref, sha: $sha}}' |
      npx vercel api "/v13/deployments?teamId=$team" --scope acquisity -X POST \
        -H "Content-Type: application/json" --input - --raw >/dev/null
  fi
  sleep 10
done
echo "$alias does not serve $sha after 15 minutes." >&2
exit 1
