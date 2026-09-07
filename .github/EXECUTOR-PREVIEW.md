# Executor preview acceptance

Status: preview testing is in progress. This branch is not cleared for production.

## Configuration

- PR: https://github.com/Acquisity/Foreman/pull/118 (draft).
- Preview bot channel: C0BUF4GU8C8. Bot: U0BTGKF57T7.
- Executor: https://executor.acquisity.ai, version 1.6.8, Aaron Fraga's Acquisity account holding the intended company connections.
- Vercel API-key connector: `executor.acquisity.ai/foreman-preview`, attached only to Preview. It is already set as the branch-specific `EXECUTOR_MCP_CONNECTOR`; `EXECUTOR_BASE_URL` is also set.
- Ten root/critic toolkits and five helper toolkits exist. Each connects only the selected account prefixes, approves explicit installed operation paths, and blocks everything else. They are personal toolkits on the designated shared company account because Executor workspace toolkits exclude personal connections. Personal Supermemory is absent.
- The checked-in toolkit manifest records exact installed paths and missing coverage. `operation-bindings.json` contains only verified helper paths. Specs document the fixed API routes and authored GraphQL strings. Executor 1.6.8 does not enforce OpenAPI input schemas, including enums. These schemas are not authorization boundaries. Linear reads use a separate provider-enforced read-only key; writes use an attended-only helper toolkit and a different key. Raw helper operations are absent from model-facing toolkits.
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

## Current gaps

- The original 35 helper bindings now have verified installed paths; a 36th binding supports the bounded critic Sentry helper. Linear GraphQL uses dedicated API keys because its MCP OAuth token was rejected by GraphQL. A real read passed, and a guessed mutation through the scheduled read connection returned Linear FORBIDDEN. Full authored-helper preview acceptance remains required.
- The unmounted `foremanLinearReadApi` connection anchors the encrypted credential referenced by `foremanLinearWriteApi`; do not delete it without migrating that reference. Actual read bindings use `foremanLinearReadOnlyApi`.
- Vercel has no installed downstream MCP connection. Automatic OAuth registration rejects Executor's hosted redirect URI; Vercel must approve `https://executor.acquisity.ai/api/oauth/callback` for the Acquisity Executor client. This is separate from the working Foreman app connector. [Vercel explains the approved-client requirement](https://vercel.com/i/mcp-server-oauth-authorization).
- PostHog now has the original 76 Foreman read/OIDC scopes, including `user:read` and `query:read`; the earlier incomplete grant ended at property definitions. Its endpoint pins `mode=tools&readonly=true` and publishes 341 individually allowlisted read operations. The OAuth template stores the read scope list for future consent.
- Resend was reauthorized with its original `full_access` grant on the existing AI Acquisition team. `list_domains` passed. OpenRouter's stale unused dynamic client registration was replaced; its account credit read passed and only the original ten reads plus attended `send_message` are mounted.
- Stripe no longer publishes `get_stripe_account_info`. Account identity discovery succeeds with `list_available_accounts_or_orgs`, but full compatibility for the retired operation remains an explicit coverage gap. Sentry issue details and event search are available through the strict critic `read_sentry_issue` helper; `find_issues` is covered by the installed `search_issues` read. Both nested reads were exercised, and the provider rejected a guessed `update_issue` as unavailable in the session.

Local validation: `pnpm validate` passed 680 tests in 94 suites with zero errors or warnings. The fresh capability report keeps ordinary Slack at 72.9% and 73.2% of the repository and factory catalogs. All 15 installed toolkits pass the exact-catalog/default-deny configuration audit; Vercel and the retired Stripe operation keep the overall readiness gate red.

## Repeatable manual tests

Mention the preview bot in a fresh thread with `test Linear`, `test Instantly`, `test Sentry`, or another named service. The integration-testing skill requires real small reads, explicit empty-versus-unavailable handling, and no incidental writes. For full coverage:

- Test each MCP provider and every authored helper separately, including all Instantly resource types and their workspace provenance, billing identifier types, Inngest fallback and traces, Linear query/document/routing operations, and help article filtering.
- Use designated test records for attended writes; read changes back. Never use a customer's ticket or deploy a project simply to test permission.
- Give critic a complete designated evidence packet as well as the incomplete packet above. Verify its own reads and output shape.
- Attach an image for vision; also test a missing image and a Linear-hosted attachment. Do not include the expected visual answer in the request or alt text.
- A real second authorized employee must initiate both Linear and Intercom triage without being asked to sign in to either provider. Do not simulate another human by changing an actor identifier.
- Test factory and schedule lanes, denied writes, guessed nested operations, and reused sessions. Use a scratch repository for a full factory pipeline.
- Cover oversized query output, sanitization, pagination caps, cancellation, timeout, missing credentials and unavailable-versus-empty responses.

## Release gate

1. Resolve every missing binding and catalog item; do not add silent provider fallbacks. Run `pnpm executor:readiness`, then the same command with `--live` and an explicit official CLI setup profile.
2. Run `pnpm validate`, inspect root/critic catalogs and run `pnpm report:capabilities`.
3. Deploy the exact reviewed branch with its verified binding JSON and rerun the acceptance cases above. Record deployment ID, commit and test thread links.
4. After user approval and merge, attach the intended app connector and the same verified configuration to Production, deploy, and repeat small smoke reads. Preview environment values do not automatically become production values on merge.
5. Retain the previous deployment/configuration for rollback. Retire old outbound references only after observation; retain inbound Slack/Linear, GitHub, personal Supermemory, Blob, investigation memory, models, and sandbox infrastructure.


## Follow-up on the deployed helpers

Deployment `dpl_Vk7ghqnsLMMBuqgCifQf6nVMFnc4`, commit `6a5b6dd1d8fb836ed442b44fb4c4b61b61301b43`:

- [Separate bot requester](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788790584376709): Acquisity Asks Sandbox triggered successful Linear and Intercom reads without provider sign-in. This is a bot principal check; the human employee case remains distinct.
- [Authored helper reads](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788790759107279): PlanetScale SELECT 1, help filtering, Inngest runs with trace and correct truncation, and Linear related-issue search passed.
- [Critic Sentry helper](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788790759694779): independent issue details and event reads passed with declared INSUFFICIENT_EVIDENCE output for the incomplete packet.
- [PostHog, Resend and OpenRouter](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788790771432579): real reads passed; Resend passed on the fresh retry after its initial stale authorization result.
- [Instantly failure](https://acquisityworkspace.slack.com/archives/C0BUF4GU8C8/p1788790758442489): the complete 3,372-workspace result is 269,862 characters and exceeds the 256 KiB output cap. Operator verification completed all 35 pages with unique memberships. The bot's claim that this was the 100-page cap was incorrect. Internal membership validation now stays separate from the public list output budget, so a selected workspace resource read can finish without emitting the oversized list. Both the 100-page membership limit and 256 KiB output limits remain unchanged.
- Local `pnpm dev` live conversation checks remain unavailable: the checkout has no development environment and Vercel's environment runner does not supply the Connect-injected Linear/Supermemory IDs or model credentials. Compilation/unit validation and deployed Slack execution are recorded separately; no production credentials were copied into local files.
