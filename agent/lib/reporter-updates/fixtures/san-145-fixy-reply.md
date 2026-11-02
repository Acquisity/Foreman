I fixed and proved the "webhook guide" bug, and the PR (https://github.com/Acquisity/Acquisity/pull/8236) is open and ready for review. The crew's claim is held at **bot loop**, not `awaiting approval`: two CI checks fail because the Linear sync can't read SAN ticket IDs, and a person needs to decide how to handle that.

**The complaint:** the "webhook guide" link in the AI SDR webhook card's notice opened a 404 for customers whose webhook URL was waiting for verification or had failed it.

**What was wrong:** the link pointed at the app's own docs page, `/developer/campaign-agent/guides/webhooks`. On the app, only platform admins can open that page; everyone else gets a 404. The bug came in with PR #7915. Today the live app path returns 404 and the public guide returns 200.

**What changed:** the link now goes to the public guide at `https://developer.acquisity.ai/guides/webhooks`. A regression test covers both the waiting and failed states; it failed on main and passes with the fix. I also added a line to `docs/agents/docs-site.md`: this link only works while public developer docs are switched on and the webhooks guide stays listed.

**Proof** (stills 1 to 4, a before/after comparison and both videos are on this ticket, titled `SAN-145 ad2cebe6b7 …`):
- I recorded on a copy of the reporter's workspace on the PR's preview. Their webhook there had failed verification.
- **Before**, on main's code (CI run 41321199938): clicking "webhook guide" opened a 404. This is a link bug, so clicking it is the reproduction.
- **After**, on the fix (`ad2cebe6b7`, CI run 41322801735): the same click opens the public Webhooks guide.
- The walk only viewed the page and clicked a link, so no second replay was needed.
- Comparison image: https://uploads.linear.app/8807bf43-0482-43f0-9330-ad288c517bf2/7cc3e8b0-8ffd-4e79-899c-4bd1decd696a/515dfecd-df97-4377-90d5-07741d82ad70

**Measured or inferred:**
- Measured: the link opened a 404 on main and opens the public guide on the fix, in the browser on the replica.
- Measured: the regression test fails on main and passes on the fix, along with the 391 tests in the related folders.
- Inferred from the unit test only: the waiting state behaves the same in the browser. The replica's webhook was in the failed state.
- Not re-counted: how many workspaces see the notice. The read-only database login is blank on this box, so the ticket's figure of 2 from 29 Oct stands unchecked.

**Review:** an independent multi-model review (Claude and GPT on correctness, GPT on maintainability, a GPT verifier) found one minor gap: nothing recorded that the link depends on the public-docs switch. I fixed that with the docs line and a recheck confirmed it. The same review raised a concern that white-label partner clients would land on Acquisity-branded docs; the verifier ruled that out, since the settings menu and Help Centre already link the same public site. Grok was unavailable, and the review passes. Type checks, unit, database, integration and end-to-end tests, and Lint and Format all pass. React Doctor found nothing. CodeRabbit skipped the PR because its author is a bot, and didn't answer a request to review it.

**Decision needed:** the Linear Ticket Check and the Linear sync job (pr-event-handler, run 41323900923) fail. The sync only recognises ENG, AIAA and SEL ticket IDs, so it can't find SAN-145. It then reads the PR's comments, where Linear's link-back quotes this ticket's text with four ENG IDs, and fails because it finds more than one ticket. This is the first PR from the SAN test team. The crew may carry a red check into `awaiting approval` only when the same check also fails on main. This one can't fail on main because it reads the PR's ticket ID, and the crew rules forbid adding another ticket ID to the PR.

My recommendation: a person accepts these two failures as the SAN test team's known gap and stages the claim themselves:
`bun bug-crew stage SAN-145 "awaiting approval" "https://github.com/Acquisity/Acquisity/pull/8236 proof ad2cebe6b7"`
Then run `bun bug-crew approve SAN-145` as usual. Separately, adding SAN to the sync's accepted ticket prefixes would stop this happening on every future test run. That change belongs in its own PR, which I haven't opened.

The PR, its preview and the replica stay up. Local videos and stills are deleted, and nothing is left running.