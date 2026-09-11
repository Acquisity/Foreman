# Executor preview acceptance

Status: preview testing is in progress. This branch is not cleared for production. The current design is one shared `Foreman` toolkit. Earlier role/profile evidence below is historical and superseded by the consolidation section.

## Current setup for every PR

1. Inspect the live Foreman Preview Slack connector and its triggers. Target the current PR branch at the existing Slack channel route, remove the previous Preview trigger branch, and read the trigger configuration back. Preserve Production routing. The connector UID, bot, channel, and branch names recorded under historical sections below must be verified live before reuse.
2. Attach the intended Preview Executor app connector. Set branch-scoped Preview `SLACK_CONNECTOR` and `EXECUTOR_MCP_CONNECTOR` to the actual attached UIDs, `EXECUTOR_BASE_URL=https://executor.acquisity.ai`, and `EXECUTOR_OPERATION_BINDINGS` to the compact JSON contents of `.github/executor/operation-bindings.json` after catalog verification. There is no Executor enable switch; missing auth or `{}` bindings disables access. Retain the Preview's other channel, model, storage, and sandbox configuration.
3. Keep `FOREMAN_SUPPORT_ENABLED` and `FOREMAN_SUPPORT_FOLLOWUPS_ENABLED` false during ordinary smoke; the support queue is not accessed while both are disabled. Preserve the existing investigation-memory configuration for those checks. Before enabling scheduled support tests, require a separate private, migrated Preview database and queue through `FOREMAN_MEMORY_DATABASE_URL`; Preview must never claim the Production support queue. Scheduled tests also need a current watermark, selected synthetic conversations, the verified Intercom handoff app ID, and the support toolkit grants. The support Slack channel is fixed in `agent/lib/support/config.ts`, so changing the Preview bot trigger does not isolate scheduled delivery. See [INTERCOM-SUPPORT-CRON.md](./INTERCOM-SUPPORT-CRON.md).
4. Run `pnpm executor:contract`, `pnpm executor:readiness`, and the metadata-only live check with an explicit `EXECUTOR_SETUP_PROFILE`. The support live check uses `--support --live`. These checks do not prove provider authorization.
5. Deploy or redeploy the exact current PR commit after environment or connector changes. Verify deployment ID, commit SHA, active Preview route, and absence of the stale Preview trigger. Send a fresh mention and run [UAT-BATTERY.md](./UAT-BATTERY.md), including actual root, native-child, and critic provider reads plus a staged image. Record Slack links and deployed logs; a successful operator OAuth probe is not proof of the bot's app credential.
6. Aaron tests and accepts this PR before the next opens. Repeat branch targeting and branch-scoped environment setup for the next PR. Production deployment follows merge to `main`; Preview environment does not automatically propagate. Rollback is a revert on `main`, never `vercel rollback`.

## Configuration (historical, before shared-toolkit consolidation)

- PR: https://github.com/Acquisity/Foreman/pull/118 (draft).
- Preview bot channel: C0BUF4GU8C8. Bot: U0BTGKF57T7.
- Executor: https://executor.acquisity.ai, version 1.6.8, Aaron Fraga's Acquisity account holding the intended company connections.
- Vercel API-key connector: `executor.acquisity.ai/foreman-preview`, attached only to Preview. It is already set as the branch-specific `EXECUTOR_MCP_CONNECTOR`; `EXECUTOR_BASE_URL` is also set.
- Ten root/critic toolkits and five helper toolkits exist. Each connects only the selected account prefixes, approves explicit installed operation paths, and blocks everything else. They are personal toolkits on the designated shared company account because Executor workspace toolkits exclude personal connections. Personal Supermemory is absent.
- The checked-in toolkit manifest records exact installed paths and missing coverage. `operation-bindings.json` contains only verified helper paths. Specs document the fixed API routes and authored GraphQL strings. Executor 1.6.8 does not enforce OpenAPI input schemas, including enums. These schemas are not authorization boundaries. Linear reads use a separate provider-enforced read-only key; the write operation uses a different existing key and is available in every helper profile. Raw helper operations are absent from model-facing toolkits.
- No production deployment or production connector attachment was changed.

## Evidence from 2026-09-07

| Check | Result | Evidence |
|---|---|---|
| Foreman preview → Vercel Connect → Executor | PASS | Deployed preview authenticated and discovered the attended connection |
| MCP provider reads | 12 PASS, Resend BLOCKED | [Slack provider test](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788787049312249): Linear, Sentry, Autumn, Axiom, Exa, Inngest, Intercom, Jam, Lucent, Modem, Neon, Stripe |
| Critic independent read and incomplete packet | PASS | [Critic test](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788787064742079): its own Linear read and declared INSUFFICIENT_EVIDENCE output |
| Slack image staging and vision child | PASS | [Vision test](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788787481571139): correctly read MANGO-731, purple triangle, four green circles, queue 27 and PREVIEW from pixels |
| Guessed nested calls | PASS | Executor returned `tool_blocked` for critic Linear save_issue, factory Linear get_issue, root raw PlanetScale query, and root Executor connections administration |
| Helper transports | PASS for sampled reads/error paths | PlanetScale SELECT 1, help search, Inngest apps and Instantly membership succeeded; nonexistent Autumn/Stripe identifiers preserved HTTP 404 |

These are scoped results, not full provider certification. The transport probes used the official Executor operator OAuth session; the authored helpers also need verification through the deployed preview bot and its app connector.

## Pre-consolidation gaps (historical)

- The original 35 helper bindings now have verified installed paths; a 36th binding supports the bounded critic Sentry helper. Linear GraphQL uses dedicated API keys because its MCP OAuth token was rejected by GraphQL. A real read passed, and a guessed mutation through the scheduled read connection returned Linear FORBIDDEN. Full authored-helper preview acceptance remains required.
- The unmounted `foremanLinearReadApi` connection anchors the encrypted credential referenced by `foremanLinearWriteApi`; do not delete it without migrating that reference. Actual read bindings use `foremanLinearReadOnlyApi`.
- Vercel REST is installed as `foreman_vercel_api` with the owner-approved Foreman-scoped key. Preview discovery, project metadata, deployment listing and build logs passed with HTTP 200 in the owner-reported smoke test. The hosted MCP OAuth callback restriction no longer blocks this connection.
- PostHog now has the original 76 Foreman read/OIDC scopes, including `user:read` and `query:read`; the earlier incomplete grant ended at property definitions. Its endpoint pins `mode=tools&readonly=true` and publishes 341 individually allowlisted read operations. The OAuth template stores the read scope list for future consent.
- Resend was reauthorized with its original `full_access` grant on the existing AI Acquisition team. `list_domains` passed. OpenRouter's stale unused dynamic client registration was replaced; its account credit read passed and only the original ten reads plus attended `send_message` are mounted.
- Stripe no longer publishes `get_stripe_account_info`. Account identity discovery succeeds with `list_available_accounts_or_orgs`, and the retired operation is no longer an expected readiness requirement. Sentry issue details and event search are available through the strict critic `read_sentry_issue` helper; `find_issues` is covered by the installed `search_issues` read. Both nested reads were exercised, and the provider rejected a guessed `update_issue` as unavailable in the session.

Historical pre-consolidation validation (recorded in `963754d`): `pnpm validate` passed 681 tests in 95 suites with zero errors or warnings. The fresh capability report keeps ordinary Slack at 72.9% and 73.2% of the repository and factory catalogs. All 15 installed toolkits pass the exact-catalog/default-deny configuration audit; Vercel and the retired Stripe operation keep the overall readiness gate red.

## Repeatable manual tests

Mention the preview bot in a fresh thread with `test Linear`, `test Instantly`, `test Sentry`, or another named service. The integration-testing skill requires real small reads, explicit empty-versus-unavailable handling, and no incidental writes. For full coverage:

- Test each MCP provider and every authored helper separately, including all Instantly resource types and their workspace provenance, billing identifier types, Inngest fallback and traces, Linear query/document/routing operations, and help article filtering.
- Use designated test records for attended writes; read changes back. Never use a customer's ticket or deploy a project simply to test permission.
- Give critic a complete designated evidence packet as well as the incomplete packet above. Verify its own reads and output shape.
- Attach an image for vision; also test a missing image and a Linear-hosted attachment. Do not include the expected visual answer in the request or alt text.
- A real second authorized employee must initiate both Linear and Intercom triage without being asked to sign in to either provider. Do not simulate another human by changing an actor identifier.
- Test native delegates and schedule lanes, denied writes, guessed nested operations, and reused sessions. Use a scratch repository and an existing test ticket for direct feature-branch and pull-request delivery.
- Cover oversized query output, sanitization, pagination caps, cancellation, timeout, missing credentials and unavailable-versus-empty responses.

## Release gate

1. Resolve every missing binding and catalog item; do not add silent provider fallbacks. Run `pnpm executor:readiness`, then the same command with `--live` and an explicit official CLI setup profile.
2. Run `pnpm validate`, inspect root/critic catalogs and run `pnpm report:capabilities`.
3. Deploy the exact reviewed branch with its verified binding JSON and rerun the acceptance cases above. Record deployment ID, commit and test thread links.
4. After user approval and merge, attach the intended app connector and the same verified configuration to Production, deploy, and repeat small smoke reads. Preview environment values do not automatically become production values on merge.
5. Roll back with a revert commit on `main` and let Vercel deploy it; never use `vercel rollback`. Retain the previous configuration as evidence. Retire old outbound references only after observation; retain inbound Slack/Linear, GitHub, personal Supermemory, Blob, investigation memory, models, and sandbox infrastructure.

## Follow-up on the deployed helpers

Deployment `dpl_Vk7ghqnsLMMBuqgCifQf6nVMFnc4`, commit `6a5b6dd1d8fb836ed442b44fb4c4b61b61301b43`:

- [Separate bot requester](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788790584376709): Acquisity Asks Sandbox triggered successful Linear and Intercom reads without provider sign-in. This is a bot principal check; the human employee case remains distinct.
- [Authored helper reads](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788790759107279): PlanetScale SELECT 1, help filtering, Inngest runs with trace and correct truncation, and Linear related-issue search passed.
- [Critic Sentry helper](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788790759694779): independent issue details and event reads passed with declared INSUFFICIENT_EVIDENCE output for the incomplete packet.
- [PostHog, Resend and OpenRouter](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788790771432579): real reads passed; Resend passed on the fresh retry after its initial stale authorization result.
- [Instantly failure](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788790758442489): the complete 3,372-workspace result is 269,862 characters and exceeds the 256 KiB output cap. Operator verification completed all 35 pages with unique memberships. The bot's claim that this was the 100-page cap was incorrect. Internal membership validation now stays separate from the public list output budget, so a selected workspace resource read can finish without emitting the oversized list. Both the 100-page membership limit and 256 KiB output limits remain unchanged.
- Local `pnpm dev` live conversation checks remain unavailable: the checkout has no development environment and Vercel's environment runner does not supply the Connect-injected Linear/Supermemory IDs or model credentials. Compilation/unit validation and deployed Slack execution are recorded separately; no production credentials were copied into local files.


## Pre-consolidation preview acceptance (historical)

Deployment `dpl_73cHX27u4Xtw9YhQxDK34mAiZDVK`, commit `2e4fbb2` is ready; GitHub validation passed.

- [Instantly selected-resource retry](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788791706473749): accounts, campaigns and emails each returned valid empty results for the designated test workspace with complete membership validation and correct workspace provenance. The oversized global list remains bounded and unavailable; resource reads do not return that list.
- [Linear attended writes and critic challenge](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788791209097539): SAN-63 retained one investigation document across create and update; priority 4 read back correctly. Critic returned all twelve results and CHALLENGE because the fixture cited Foreman code. Its existing checkout tool only permits `Acquisity/Acquisity`, so this demonstrates the mismatched-source failure, not successful commit pinning. Positive complete-packet fixtures must use that supported repository; this migration does not widen its repository restriction.
- [Missing vision image](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788791343393679): vision explicitly reported the missing file and returned no invented content.
- [Private Linear-hosted vision image](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788791801795729): the URL download through the retained Linear app authentication succeeded; vision independently reported the synthetic code, shapes, count, queue value and environment label correctly. The attachment lives only on the SAN-63 synthetic fixture.

- [Corrected critic source pin](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788791868643359): SAN-64 used the supported product repository. Critic independently checked out `d7c4e45d0ce276b995d0591665c52c17791da0e6` and verified the dependency fact. All twelve criteria were returned. The parent supplied the document creation timestamp instead of its current update timestamp; critic correctly returned CHALLENGE for stale evidence. Exact source pinning and stale-document rejection passed; a successful current-document review remains unproven.

## Fifteen-toolkit design (superseded by shared toolkit consolidation)

Toolkits are permission lists over existing connections. They do not duplicate provider credentials. Three groups (root, critic, helper transport) each have five trusted-session profiles (attended, limited, factory, scheduled, scheduled-internal). Foreman selects the profile from dispatch-owned state; the model cannot select it through tool arguments. Separate static connection URLs fit eve 0.44 and let Executor enforce exact operation policies. Root and critic cannot discover raw helper operations.

Fifteen is a consistent mapping, not a minimum platform requirement. The two scheduled helper profiles currently have identical operation lists and could share a toolkit in a later simplification; the other installed lists differ. The security requirement is preserving the effective permissions and hidden helper boundary, not maintaining a particular toolkit count.


## Read-only duplicate walkthrough regression (historical topology)

[Aaron's ENG-13531 test](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788792413142509) returned concrete provider evidence but omitted handling Stages 5 through 7, then incorrectly said triage-handling only applies to fresh investigations. The authored handling skill includes Duplicate outcomes; only critic is skipped for a duplicate. An explicit every-step read-only walkthrough must describe the inherited priority/assignee, proposed project/labels, existing master link, document/comment actions and skipped memory writes without applying them.

The bounded runtime audit found 38 authored/tool actions in session `wrun_41M1Y5CAA50GR9ARE7X8JD798E`, including four PlanetScale query calls, the existing customer/search/Inngest helpers, and twelve Executor executions. No authored document, routing or memory-write tool appeared. Lifecycle `ok` is only outer execution status and does not prove provider success or establish the contents of nested Executor calls. The pasted report does not supply a new blast-radius measurement and does not verify Instantly resource state: an oversized complete list plus an unresolved display name is not evidence that no provider workspace exists.

The instructions now retain handling in explicit read-only walkthroughs, distinguish duplicate handling from critic eligibility, require honest stage/lane coverage, and explain complete-membership resource reads and unresolved provider identities. Sentry, PostHog and Resend discovery hints also match the installed Executor catalog; the former no-allowlist claim was removed. These are instruction changes, not a new runtime read-only mode or widened permissions.


## Instantly discovery follow-up

The selected-resource fix above still required a known provider ID or exact name. Discovery now accepts an optional partial-name `search`, `limit` (default 20, maximum 100), and `startingAfter` cursor on the existing `list_instantly_subworkspaces` helper. Empty input remains valid and returns a bounded first page. The helper validates the complete source membership set before filtering, sorts results by workspace ID, and returns match totals plus a continuation cursor. Public pages also stay within 256 KiB, including when workspace names are large. `membershipComplete` describes source validation, not an exhaustive public result page. Resource reads still require an evidence-backed exact selection and preserve their existing filtering and provenance.

Regression fixtures cover search matches on later pages, ambiguous names, empty matches, invalid later membership data, oversized combined results, byte-bounded continuation across reordered provider pages, and invalid inputs/cursors. Preview acceptance should search by a partial name without a supplied ID, then use the returned candidate ID for an authored resource read. Live results for this follow-up are recorded on PR #118 after deployment.


## Linear access policy clarification (historical topology)

The user clarified that Foreman should have normal Linear read/write access in every execution mode. All root and critic profiles now share the attended Linear catalog, and all helper profiles include the existing Linear read and write operations. Removed factory/schedule Linear transport denials and unattended approval denials on document/routing helpers. Critic instructions still prohibit writes; its shared Linear connection is not an enforcement boundary. Earlier factory/critic/schedule Linear denial probes above document the superseded policy and are no longer acceptance criteria. Other provider, raw-helper, management, and session-profile boundaries remain in place.


## Shared toolkit consolidation

One `Foreman` toolkit (`/mcp/toolkits/foreman?artifacts=false`) replaces the fifteen execution profiles and the obsolete four-service proof toolkit. Root and critic use the same app connection, and authored helpers invoke that same endpoint. All selected platform and helper operations are represented once in the manifest. No new workflow or subagent requires a toolkit.

Workflow behavior is defined by skills; critic remains instructed to review without writing. Provider credentials and scopes are unchanged. Helpers retain their validation, membership checks, pagination, filtering, deadlines, and result formats, while their underlying operations are discoverable in the shared toolkit. Previous checks expecting per-profile denials or hidden helper operations no longer describe the intended policy.

At that stage Vercel setup and the retired Stripe operation were recorded as catalog gaps; the REST setup below and working Stripe account discovery supersede those gaps. Deployment-specific acceptance and retirement evidence are recorded on PR #118. Restore the previous toolkit configuration before rolling back to a deployment that references its old URLs.


## Typed helper transport review follow-up (2026-09-07)

The review follow-up replaces simulated provider HTTP with typed operation calls, generates both Linear specs from canonical documents, preserves available retry metadata, and splits Instantly's tests by responsibility. At typed-helper commit `f4df20c`, local `pnpm validate` passed 648 tests in 93 suites with zero errors or warnings. Tests for removed HTTP reconstruction and domain body readers were replaced with typed-client fixtures; Executor's actual body streaming, byte cap, deadline, and cancellation tests remain. The end-to-end fixture covers MCP error parsing through the client and Instantly retry behavior.

All eight read and five write Linear documents match the installed Executor enums exactly. The live toolkit's exact catalog and policy audit passes; the then-recorded Vercel and Stripe gaps are superseded below. The custom Inngest API definition now passes its optional `includeOutput` boolean, preserving the trace fallback, with no tools added or removed. This branch's Preview bindings now contain operation paths only. Root compiles with Executor plus personal Supermemory; critic compiles with Executor.

No Executor server code or server deployment was changed. The unapplied server-owner patch and its remaining verification are recorded in [EXECUTOR-RETRY-AFTER.md](./EXECUTOR-RETRY-AFTER.md). Foreman stops after one rate-limited invocation when the currently deployed server supplies no retry interval. Fresh deployed-preview results for this follow-up are recorded on PR #118; earlier acceptance above is not evidence for this refactor.

## Vercel REST preview acceptance (2026-09-07)

The owner reported successful read-only Foreman preview execution through `foreman_vercel_api`: discovery, `getProject` for Foreman, `getDeployments` returning three READY deployments, and `getDeploymentEvents` reporting a successful 52-second build. All calls succeeded; nothing was changed. The browser health check also passed for the Foreman project. No additional trace submission is required for this reported smoke-test acceptance.

The installed connection has 417 tools, with 65 destructive operations blocked and 352 enabled. The shared toolkit uses a connection-wide allow with exact destructive exceptions; readiness now checks those declared exceptions and their precedence while retaining exact allows/default deny for the other connections. See the manifest and tool availability audit for the inventory. Runtime-log discovery succeeded, but a runtime-log read was not part of this smoke test. Production still needs its own Foreman-to-Executor connector attachment and environment configuration before release; this work does not deploy or merge Foreman.
