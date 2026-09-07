# Foreman to Executor implementation audit

The source audit started from current remote main, 119bb01. It found eighteen root MCP definitions, fifteen critic definitions, and fourteen authored provider tools. Company-service connection definitions are now replaced by gated Executor profiles; personal Supermemory remains direct.

The fourteen helpers retain their public inputs/results and domain logic: five PlanetScale-backed tools (query, customer lookup, schema description, billing-account lookup, weekly AI SDR report), two billing readers, two Instantly readers, Inngest run search, three Linear search/document/routing tools, and help-center search. Provider calls now use an injected Executor transport. Provider credentials no longer enter those domain helpers.

The migration also updates root and critic discovery instructions, triage/billing/SLA references, sign-in registration, CI connector placeholders, and tests. Linear's app credential remains for channel delivery and vision attachment downloads. GitHub delivery, browser, sandbox, Blob, and investigation-memory storage are outside this migration.

The previous account-by-requester and only-Linear-writes assumptions were superseded by the user's explicit decisions: shared company-service access for authorized investigations, existing attended provider writes preserved, and Supermemory kept personal. No new requester login flow is required for company evidence.

Deployment configuration is deliberately separate. The existing personal proof toolkit covers four services and is not a complete production endpoint. See [EXECUTOR-CONTRACT.md](./EXECUTOR-CONTRACT.md) for profile policies, exact operation bindings, connector provisioning, and release verification. Local tests do not establish live Executor policy enforcement or provider availability.

Linear access follows the user's clarified policy: root, critic, factory, and scheduled profiles share the same Linear catalog, and authored Linear reads/writes carry no execution-mode denial. The critic remains instructed to review read-only; its shared Linear connection is not a separate technical write restriction. Other provider restrictions remain unchanged.
