---
description: "Test a named integration, critic, vision, or the full Foreman preview setup when asked to test Linear, Instantly, Sentry, another service, or all integrations."
---

# Integration testing

Treat a request such as "test Linear" as a request for a small real read through the active connection. Use the shared executor connection. Discover the installed path, inspect its schema, and invoke the operation. Never invent a provider path. Provider authorization errors are operator configuration failures, not a reason to ask the requester to sign in.

A passing connection search proves discovery only. Report PASS only after a real read succeeds. An empty successful response is PASS with no matching results; an error or unavailable connection is BLOCKED or FAIL, never empty data. If an MCP result has isError set, the read failed even when Executor's outer call completed. Never report an integration as fully tested after one read; identify which parts remain untested.

Default to read-only tests. Use a supplied test identifier when one is needed. Otherwise perform a bounded list, search, or health call. Return service, exact operation or authored helper, PASS/FAIL/BLOCKED, and one short reason. Do not return raw customer rows, messages, provider error bodies, arguments, credentials, or authentication headers. Do not write memory, route tickets, create documents, send email, deploy, or run paid test inference as a side effect of a generic test request. Write tests need an explicit test-record instruction and a designated test target, then read the result back.

## Provider checks

- Linear: one small issue/team read. For full helper coverage, separately test find_related_issues and the investigation-document/routing helpers on designated test tickets.
- Instantly: use the authored workspace and resource helpers. Resolve accepted workspace membership completely before a bounded account, campaign, or email read. Preserve workspace ID/name provenance and filtered output. A workspace listing alone does not pass the resource helpers. Test discovery using a partial workspace name with `list_instantly_subworkspaces({ search: "name fragment" })`, without supplying an ID. Verify match totals and bounded results; use `nextStartingAfter` with the same search to continue when needed. Use the evidence-backed returned ID for a resource read. Discovery validates every source page before filtering, even when its public result is paginated; a 100-page source cap still fails closed.
- PlanetScale: use planetscale_execute_read_query with SELECT 1 AS foreman_preview_probe. Test customer and billing lookups only with a supplied test identifier.
- Autumn and Stripe: make one catalog/account read and separately exercise the authored billing helper with a designated billing-account or Stripe identifier. A wrong identifier is distinct from unavailable credentials.
- Inngest: a small health/list read, then find_function_runs for a supplied function/window when full helper coverage is requested. Preserve partial results when a trace is unavailable.
- Help center: find_help_article with a short ordinary query; verify article filtering and an explicit advisory error on failure.
- Sentry, Axiom, Exa, Intercom, Jam, Lucent, Modem, Neon, PostHog, Resend, OpenRouter, Vercel: discover and use one small read within the existing grant. OpenRouter inference and Vercel writes are separate attended tests.
- Personal Supermemory: test only on the requester's explicit personal-memory test request. It remains separate from shared company integrations.

For workspace discovery pagination, pass the returned `nextStartingAfter` value as the next call's `startingAfter`, keeping the same search.

## Critic

Invoke critic with its normal declared output schema; never override that schema. The child must perform its own source reads through its own connection. A successful root read is not evidence of child access. A complete test includes a valid designated evidence packet and a deliberately incomplete packet. The incomplete packet must produce INSUFFICIENT_EVIDENCE, never invented approval. Verify that the critic follows its read-only instructions while sharing root company access. Check expected writes only on designated test records. Executor administration remains excluded; helper API operations are part of the shared toolkit.

## Vision

Use an actual image attachment. Find the staged attachment path supplied by the channel and delegate that path and a precise visual question to vision. Report its answer, visible_text, and uncertainties. Do not fill in missing details from the message or alt text. Vision must open the image with read_image; it does not need company-service connections. A missing or unreadable image must produce an explicit limitation, never a claimed successful pixel read. Linear-hosted attachments also need a separate test because their download authorization differs from Slack's staging.

## Read-only triage walkthrough

A request to walk every triage step is broader than a connection smoke test. Follow triage-investigate through its Stage 4 checkpoint and triage-handling through Stages 5, 6 and 7, reporting proposed actions or explicit reasons they are already satisfied or not applicable. Reuse prior evidence without presenting historical counts as current measurements. A duplicate skips critic under the normal rule, not handling. Report each evidence lane as read, not applicable, unavailable or unverified; a name that did not resolve is not a successful provider-resource read. Describe writes instead of performing them, and keep any proposed investigation document inline.

## Full preview test

Test providers, authored helpers, critic, and vision separately. Record failures and untested cases explicitly. Do not equate this conversational smoke test with production readiness. The release checklist also requires a real second requester, allowed attended writes on test records, backend negative policy checks, factory/schedule lanes, cancellation/timeouts, and deployment-specific configuration verification.
