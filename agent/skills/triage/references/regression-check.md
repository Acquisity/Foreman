# Regression check

Load this in Stage 4 before any `Bug` verdict, once the code is located. A bug main already fixes is not new engineering work, and a bug a recent change introduced should name that change. Foreman reads remote HEAD, which is neither what production serves nor what happened to this code in the last 30 days, so check both.

## Run it

1. Fix the failure time: the time the claim names, else the ticket's creation time with `failureAtSource: "ticket-created"`.
2. Call `check_regression` with the ticket, the commit you read, the file, the function and the line range of the code the cause runs through (read the range with `read_file` at that commit; never a function name, since a name can match an import line), and the failure time. It completes the clone's 30-day history and proves it, and git follows the range back through every earlier revision itself. `check_regression` reads the commit production serves from Acquisity/Acquisity's GitHub production deployments itself, the same read the reporter updates use; pass nothing about deployments.
3. When it returns commits, read each patch and call it again with a label for every one: `introduced` (creates or restores the failure), `fixed` (removes it) or `neither`. The latest labelled commit decides, so a fix followed by a revert is `introduced`. Each commit listed under `unavailable` names its reason: an unavailable commit is a merge git shows no patch for or a patch too long to show whole: never label it, and if it is newer than the deciding commit the result is `unchecked`.
4. Copy the three facts into the document's `## Regression check` section from the tool's record, and note under them the file and line range and the failure time and its source, so the critic can rerun it. `decide_triage` reads the same record; neither accepts a result you type in. The record answers only for the file, function, line range, commit read and failure time you passed. Pass `decide_triage` the same file, function, line range (`codePath.lines`) and commit, and the same `failureAt`; if the investigation corrects any of them, check again before `decide_triage`, and save the document again with the new lines.

Whether a fix was already live when the customer hit the failure is out of scope: a fix that was on main before the failure time is `unchecked`, because it can't be shown to fix this failure.

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
