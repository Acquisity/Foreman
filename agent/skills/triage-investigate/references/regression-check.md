# Regression check

Load this in Stage 4 before any `Bug` verdict, once the code is located. A bug main already fixes is not new engineering work, and a bug a recent change introduced should name that change. Foreman reads remote HEAD, which is neither what production serves nor what happened to this code in the last 30 days, so check both.

## Run it

1. Read what production serves, from `foreman_vercel_api` (discover the exact paths first). Find the project that deploys `apps/web` of Acquisity/Acquisity and record its name in the document. Take `current`, the deployment the project's production target serves now (a rollback shows as an older commit, never the newest deployment), and `timeline`, its READY production deployments newest first, paged back until one is older than the failure time (at most 50). Each is `{commit: meta.githubCommitSha, readyAt}`. A different project, a failed read or a missing commit means `current: null`: write `Could not run` for that part and go on.
2. Fix the failure time: the time the claim names, else the ticket's creation time with `failureAtSource: "ticket-created"`.
3. Call `check_regression` with the ticket, the commit you read, the file and the line range of the code the cause runs through (read the range with `read_file` at that commit; never a function name, since a name can match an import line), the failure time and the deployments. It deepens a shallow clone to 30 days itself. Give a distinctive `needle` string instead of a range only when no range fits.
4. When it returns commits, read each patch and call it again with a label for every one: `introduced` (creates or restores the failure), `fixed` (removes it) or `neither`. The latest labelled commit decides, so a fix followed by a revert is `introduced`.
5. Copy the three facts into the document's `## Regression check` section from the tool's record, and note under them the file and line range, the failure time and its source, the Vercel project and the deployments you passed, so the critic can rerun it. `decide_triage` reads the same record; neither accepts a result you type in. If the evidence changes and you check again, save the document again with the new lines.

## What each result does

| Result line | Stage 5 and 6 |
| --- | --- |
| `introduced by <sha>` | The Bug goes on as before. Name the commit as the root cause's origin in the document and the master. |
| `none` | Nothing touched that code in 30 days. Goes on as before. |
| `unchecked: <reason>` | The lane could not run or could not decide. Record `Could not run: <reason>`, lower the confidence and go on. Never write `none` in its place. |
| `fixed on main and live, by <sha>` | `decide_triage` returns `Resolved by triage`. No master, no engineering hand-off, nothing for Devin. It closes as `Done`, not `Canceled`: the earlier fix is the change that was made. In the one `route_ticket` call, link the pull request that merged the fixing commit with `route_ticket` `links`, so the reporter update tells the requester it is fixed. The comment tells the requester it is already fixed, without the commit; the document names the commit. |
| `fixed on main, not deployed yet, by <sha>` or `fixed on main, deploy status unknown, by <sha>` | `decide_triage` returns `Support/Product follow-up`, still a `Bug`: the decision's `route` already names the area owner, so pass it unchanged. No master, no hand-off. The ticket stays open. The document names the fixing commit and a deploy note (`goes live with the next deploy; confirm after it ships`, or `confirm it is live`). The comment tells the requester a fix is on its way, without the commit, and it is closed only after the deploy. |

If `decide_triage` comes back `unproven` with the regression check as the only missing item, that is yours to close: run the check, label every commit and call it again. Never take the unproven branch, or tell the requester anything, for it.

The critic grades this result (criterion `reachability`), so pass it among the claims the decision turns on, with the deployed commit.
