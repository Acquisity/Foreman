#!/usr/bin/env bash
# Publishes a generated bot PR for the widget-guide and widget-tools workflows.
#   generated-pr.sh publish <branch> <committer name> <title> <body file> <file>...
#     commits the files onto <branch>, force-pushes it with lease, and opens or
#     updates its one open PR.
#   generated-pr.sh close <branch> <comment>
#     closes the branch's open PR with the comment, when one is open.
#   generated-pr.sh open <branch>
#     prints the number of the branch's open PR, or nothing.
#   generated-pr.sh ticket <branch> <kind>
#     files or reuses the Fixy ticket for the branch's open PR (ENG-20297).
# Needs GH_TOKEN, and LINEAR_API_KEY for ticket; GitHub Actions sets the rest.
set -euo pipefail

open_pr() {
  gh api "repos/$GITHUB_REPOSITORY/pulls?head=$GITHUB_REPOSITORY_OWNER:$1&state=open" --jq ".[0].$2 // empty"
}

command=$1
branch=$2
case "$command" in
  publish)
    name=$3 title=$4 body=$5
    shift 5
    git config user.name "$name"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git switch -c "$branch"
    git commit -m "$title" -- "$@"
    git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push --force-with-lease origin "$branch"
    number=$(open_pr "$branch" number)
    if [[ -n "$number" ]]; then
      gh api -X PATCH "repos/$GITHUB_REPOSITORY/pulls/$number" -f title="$title" -F body=@"$body" --jq .html_url
    else
      gh api -X POST "repos/$GITHUB_REPOSITORY/pulls" -f title="$title" -f head="$branch" -f base=main -F body=@"$body" --jq .html_url
    fi
    ;;
  open)
    open_pr "$branch" number
    ;;
  close)
    number=$(open_pr "$branch" number)
    if [[ -n "$number" ]]; then
      gh api -X POST "repos/$GITHUB_REPOSITORY/issues/$number/comments" -f body="$3" > /dev/null
      gh api -X PATCH "repos/$GITHUB_REPOSITORY/pulls/$number" -f state=closed --jq .html_url
    fi
    ;;
  ticket)
    url=$(open_pr "$branch" html_url)
    if [[ -z "$url" ]]; then
      echo "No open PR on $branch; no ticket."
      exit 0
    fi
    pnpm exec tsx scripts/generated-pr-ticket.ts --kind "$3" --pr "$url"
    ;;
  *)
    echo "Usage: generated-pr.sh publish|open|close|ticket <branch> ..." >&2
    exit 2
    ;;
esac
