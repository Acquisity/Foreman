# ENG-13999 fresh-21 follow-up

This patch corrects confirmed semantics and controls the existing investigation path. It does not establish rollout readiness. No new live role-play was run.

## Verified baseline, 21 September 2026

- Foreman PR #141 and local HEAD: `ed50c962b5b4afa4628a3f95914a0f9d3af4a22c`.
- Vercel inspection and deployment API: the widget alias resolves to `foreman-f8kepx7jv-acquisity.vercel.app`, deployment `dpl_2PM6aGnyrDNgvnaCYPgkyapEMyeb`, with that Git SHA.
- Acquisity PR #6459 and local HEAD: `3342708290b72572160a66f09aac70fd4480a270`.
- Preserved existing work: Foreman's uncommitted 240-second deadline edit, Acquisity's `.gitignore` change, and all existing test scripts.
- Evidence: Acquisity `.context/widget-ed50c96-fresh21-report.html`, its `-claude-handoff.md`, `-audit.json`, `-summary.json`, and private `-events.local.json`. These cover 21 cases, 26 messages, 18 reviews, one deadline and two appropriate handoffs. Historical diagnoses are not current account evidence.
- Linear MCP required reauthentication; PRs and supplied evidence supplied context. No Linear write was attempted.

## Changes

| Evidence | Existing path corrected | Validation limit |
| --- | --- | --- |
| fresh-20: zero verified Instantly leads | Lead verification uses Acquisity's run-source-or-verified-flag predicate. Count discrepancies no longer diagnose unfinished processing. | Actual generated count subquery runs over synthetic SQL rows, including foreign-organization rows. No live customer comparison. |
| fresh-04: one selected read produced 12 calls | The existing selector chooses the first investigation read, then at most one novel call per selected step. Initial selection does not reclassify intent, ambiguity or human eligibility. | Synthetic batch, duplicate, next-page, conversation and fallback tests. Subsequent distinct useful reads remain possible. |
| fresh-04/08/15: product steps without articles | The existing 14-call budget reserves the last two calls for article search/read. Budget instructions forbid unsupported steps. The composer cannot manufacture steps from `needsWrite`. | Generate and stream tests enforce the reserve. Article relevance and actual model compliance still need live validation. |
| fresh-05/06/13: READY, incomplete provisioning and timezone hypotheses overstated | Investigator/composer instructions preserve evidence limits. Provisioning caveats honor the saved start timestamp. KB instructions keep timezone conversion hypothetical. | Prompt changes are not proven effective by mocked tests. |
| fresh-01: no recorded job failures became no sending failures | Job-failure caveats restrict absence claims to covered areas and stop escalating missing detail alone. | Campaign dispatch remains outside that tool. |
| SDR configuration requests led to repeated thread reads | The tool description states which workspace configuration is already returned and which identifiers/settings it cannot expose. | No personal fields or access scopes added. |

Acquisity's `getVerifiedStatistics` counts all persisted Instantly rows as verified. Its `combineStatisticsFromMaps` historical-upload fallback gives the same persisted total when Instantly's earlier verified count was zero; another upload query would not change this tool's corrected count. `verificationStatus` separately controls pending/failed UI breakdowns. This tool exposes neither breakdown and must not infer failure from counts. Historical uploads and current campaign rows are different metrics.

The first step adds one short request to the existing selector after the front door has chosen investigation. No second planner or intent router was added. Subsequent decisions retain the rendered conversation and current investigation results. Selector/provider failures retain the existing bounded fallback investigation. One-call enforcement is per selected step, not per conversation.

## Whop: excluded after coverage audit

The checked source has Whop payout guidance but no API-permission article. The current Acquisity Preview `/api/docs-index` returned HTTP 200 and 442 entries, with Whop appearing only in `white-label-partners/payouts`. The public app's index returned 404, a different surface. Per Aaron's instruction, the missing-documentation case is excluded from this patch. No Whop-specific prompt, retrieval or documentation change remains. The separate no-article product-step fix remains.

## Capability audit

`widget_outreach_health` returns saved campaign status, schedules, metrics and lead-push counts. `widget_job_failures` covers SDR, provisioning and scraping, not dispatch. `widget_inbox_health` already reads live account state, which does not prove campaign sending or inbox placement.

The existing Instantly helper offers bounded account, campaign-list and email reads. Its campaign-list output keeps basic identity/status/timestamps; the checked Executor spec/catalog lacks campaign detail, sending-status and analytics bindings. A focused future extension should reuse outreach health and Executor, resolving the provider workspace and campaign ID through same-organization product joins. It must retain the inbox path's active Acquisity-provisioned connection rule and complete accepted Workspace Group validation. Group membership alone is not tenant authorization; user-owned connections remain unavailable.

Necessary reads are the matched campaign's live status/schedule, sending-status diagnosis, and bounded daily counters when needed. Instantly documents [campaign detail and sending-status GET endpoints](https://developer.instantly.ai/api-reference/groups/campaign) and [campaign analytics reads](https://developer.instantly.ai/api/v2/auditlog/def-29). Exact schemas and deployed bindings must be verified before implementation. Bound fields, dates, pages and deadlines; exclude message bodies, raw sequences and credentials. No provider operations, bindings, toolkit policy or tenant access were expanded here. Live campaign evidence remains unavailable.

SDR already resolves the assigned host internally and returns timezone, calendar type/invalid/failure state, conferencing type/static-link presence, working days and AI SDR settings. It omits handler identity, working-hour intervals and prospect names/emails from thread summaries. Paging cannot recover omitted fields or inspect live Outlook configuration. Matching a named prospect remains limited by the available identifiers; clarify rather than paging without a useful criterion.

## Latency and timeout audit

The 18 recorded reviews comprise seven JEV-only and eleven fallbacks: three `ownership_low_confidence`, eight `uncertain_not_removable`. Fallbacks totaled 241.644 seconds, averaging 21.968 seconds (range 3.825–58.775). JEV took 0.330–0.539 seconds; composition, when used, took 12.093–36.809 seconds. Overall completion median was 108.724 seconds and maximum 238.220 seconds.

No reviewer model, composer model, confidence threshold, ownership check or deletion safeguard changed. The synthetic improvement is one selected batch executing one call instead of twelve. Subsequent reads and the new initial selector call mean net latency improvement requires paired live measurements.

The inherited 240-second deadline remains unstaged; the tested deployment used 170 seconds. Acquisity polls for 285 seconds from initial send within a 300-second route. Start calls allow 60 seconds; polls allow up to 120 seconds, clipped to the remaining total. At 240 seconds, at most 45 seconds remain for finishing, less than observed finish durations. The deadline controls a pending investigation, not a shared cancellation budget across extraction, review, composition and persistence. Extraction and composition do not receive a shared remaining-time signal.

Increasing the number alone does not resolve delivery timeouts. A coordinated finish/delivery budget or resumable delivery requires Foreman/Acquisity late-result and duplicate-message tests. The generic block-to-human behavior remains a known gap; no ownership or safety check was bypassed to avoid escalation.

## Validation

`pnpm validate` passed: 1,177 tests, clean lint/typecheck, and Eve 0.54.2 discovery with zero errors or warnings. `pnpm build` and `pnpm verify:built-github` passed, including all 31 definitions and execute/approval/output phases, mounted gates and the unstamped negative fixture. Validation used Node 24.18.0, the repository package manager and documented placeholder environment. These checks ran in the working tree with the inherited, unstaged 240-second edit; the patch commit excludes that edit and retains 170 seconds. Local tests are synthetic; deployment and public index inspection are read-only live checks, not role-play acceptance.

## Focused live test plan

Use the existing harness without overwriting scripts. Pin the exact Preview SHA and both origins; retain verified conversation workspace/user scope. Capture visible replies, tool calls/results, article bodies, persisted outcomes and stage timings. Keep private identifiers only in local evidence. No customer mutations, Production traffic, Slack messages, merges or provider write tests.

| Area | Conversation and required evidence |
| --- | --- |
| Leads | Completed Instantly runs and a verified-count follow-up; imported verified/unverified rows; discrepancies in both directions. Match product counts, with no failure diagnosis or repeat-verification advice from counts alone. |
| Campaigns/inboxes | Named stopped campaign, schedule follow-up, then a different campaign. First useful read, no parameter fanout, prior results reused, saved/live limits retained and no dispatch conclusion from job failures. |
| Pagination | Known target beyond page one followed by a specific question. Use returned cursors and retain useful distinct reads; no identical retries or full enumeration. |
| SDR | Workspace scheduling configuration, then a booking with missing identity. Use existing configuration; state omitted fields; ask only for an essential identifier. |
| Website | READY with a DNS/rendering symptom, followed by “still broken.” Never equate readiness with a working page; distinguish historical/current failures; documented steps only. |
| Provisioning | Existing start timestamp, incomplete steps, no active inbox rows. Started/incomplete, never never-started; no payment attribution or repeat purchase without evidence. |
| KB and timezone | A documented settings question, then “done, what next?” Separately give a booking offset and then say both settings match. Read applicable article bodies, preserve follow-up context and keep timezone hypotheses unconfirmed. Whop permissions are excluded as missing documentation. |
| Controls | Explicit human request, complex duplicate/unmatched billing dispute, ordinary failed read, foreign-workspace request and expected partner denial. Only the first two are escalation-eligible; scope never expands. Record safety-block behavior separately. |
| Budget/latency | Repeat formerly expensive cases at baseline and patch SHA, including article-reserve pressure. Compare total calls, selector calls, first/terminal response times, fallback reasons/counts, extract/judge/compose time and timeouts. Grade accuracy independently of delivery. |

Fresh model behavior, integrated latency and timeout delivery remain acceptance work. Unit tests, deployment success, terminal delivery and allow verdicts are not rollout approval.
