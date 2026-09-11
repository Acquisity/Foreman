# UAT battery

Run this battery on every reviewed Preview slice. This replaces the factory scenarios from the earlier UAT branch with direct repository work and eve native delegation; it preserves triage, attachment, queue, cancellation, and repository-selection coverage. Follow [EXECUTOR-PREVIEW.md](./EXECUTOR-PREVIEW.md) first. Record current branch, commit SHA, deployment ID, connector trigger, test time, session IDs, Slack links, and observed results. Use the live-verified Preview bot and channel, not copied historical identifiers.

Use recent read-only cases selected by ID, dated when selected, and designated synthetic records for any allowed writes. Never use a customer record merely to test a permission. A previously passing behavior that now fails blocks the slice. Build success, `eve info`, and a model claim of success are insufficient: inspect actual action results and deployed logs. Evals cost real tokens; scratch delivery creates a branch and PR.

## Every slice

| Scenario | Action and required evidence |
| --- | --- |
| Slack Q&A | Ask a simple question. It answers without tools or delegation when unnecessary; no approval card or duplicate final reply. |
| Billing and Intercom triage | Run a read-only billing case and a separate Intercom case. Confirm actual bounded provider reads, unavailable versus empty handling, customer-safe reply, and a clickable existing ticket link where one exists. In a negative control asking only what the skill does, perform no provider reads. |
| Linear investigation and critic | Investigate a selected test ticket read-only, including evidence-based product routing and memory access where authorized. Confirm critic dispatch, independent read-only evidence checks, and a returned verdict. An unknown ticket must return not found. |
| Attached image | Attach a non-sensitive test screenshot to the triggering mention without giving away its contents. Confirm staged attachment path, actual vision dispatch in the shared sandbox, and a correct answer. Also check an authenticated Linear-hosted image and a missing-image request without claiming to have read it. |
| Intake-only Slack | Verify the Preview channel's intake-only environment membership, then ask a repository question and a controlled delivery request. It may prepare/read the repository, investigate, comment, and file allowed work; root push_branch, the same tool inherited by a native child, and GitHub createPullRequest remain denied. Native delegation must not bypass these restrictions. |
| Repository selection | Give a bare owner/repo and ask which file controls GitHub visibility. Confirm prepare_repository selects it and the next step exposes the catalog. A path such as channels/github.ts with no repository request must not bind a repository. |
| Two native delegates | Ask for two independent read-only sandbox tasks through native agent, each with a complete prompt. Confirm two distinct child sessions, shared sandbox access, successful terminal results, and a parent reply using both results. Separately verify one harmless Executor read from a native child using the deployed app auth. |
| Queue and stop, serial | Start bounded work, send a second mention while it runs, and confirm both requests remain accounted for. In a separate native-delegation run, send literal stop while a child is active; on eve 0.44 confirm parent and child cancellation and no subsequent writes or progress. A longer phrase such as stop the deploy remains normal input. Record notice latency. |
| Progress and final reply | Exercise a turn long enough to pass 5 minutes, and 15 minutes when available. Confirm each progress line appears at most once, status remains useful, and neither progress nor stale status appears after final completion, failure, or cancellation. |
| GitHub mentions only | On a scratch repo, a trusted mention starts a signed repository-bound session. Label, PR-open, check/CI, review, and synchronize events produce no new session, automatic PR summary, or stabilization work. An untrusted mention does not dispatch. |
| Direct scratch delivery, serial | Use an explicit scratch repo and existing test Linear ticket. Request a tiny README change, checks, feature branch, and normal PR. Verify exact pushed diff and check results, ticket link, and no merge. Clean up only these identified test resources after evidence is recorded. |

## Commands and runtime proof

Run `pnpm validate`, `pnpm build`, and `pnpm report:capabilities`. Root and critic each retain their intended connections; the compiled declared children are exactly critic and vision. All 31 GitHub tools must survive the built-artifact durable callback validator after the server boots and registers extension config. Do not substitute `eve info` for that proof.

Run `pnpm eval --tag fast`, `pnpm eval routing/native-delegation`, and the opt-in `routing/direct-scratch-repository` with `FOREMAN_SCRATCH_REPO` and `FOREMAN_SCRATCH_TICKET`. The scratch repo must have a `main` base branch. Use the Eve local-dev or Vercel OIDC eval principal without a Foreman trust stamp; the eval requires exactly one push approval and verifies its branch and repository before approving. Record any unavailable runtime checks plainly; do not count skipped checks as passing.

## Scheduled support, when affected

Keep support disabled unless a separate Preview database/queue, migrations, selected synthetic conversations, handoff app identity, support toolkit, and fixed Slack destination are explicitly verified. Check an intake and follow-up through the real scheduled identity, including critic/vision and journaled allowed Linear writes. The first intake queues and attempts one concise Slack result; uncertain deliveries remain for reconciliation, so successful or exactly-once delivery is not guaranteed. Unchanged follow-ups stay quiet. A premature parent completion must not release the lease or mark an unfinished investigation successful. Disabling the master flag and deploying it prevents later work; verify the active revision.

Production is deployed from main. Regressions are undone by reverting the slice on main; never use vercel rollback. Aaron accepts one PR before the next opens.
