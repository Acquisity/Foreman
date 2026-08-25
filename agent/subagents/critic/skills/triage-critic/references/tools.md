# Critic evidence surface

Every source a triage investigation can cite, and how the critic reaches it. Each entry is the root Foreman definition mounted into the child; the credential path is the root's own `managedConnect` or `userConnect` object, reused as is. The critic holds no connector, token, or credential of its own and can never write.

Connection tools are called as `<connection>__<tool>`. Root tools are called by their bare name. Use `connection_search` to discover what a connection exposes before calling it.

## Repository (root tools)

`prepare_repository` then `checkout_commit`, both bare. `glob`, `grep`, and `read_file` read the pinned checkout at `/workspace/repo`. There is no `bash`.

## Production data (root tool)

`planetscale_execute_read_query`, bare. Truncates rather than returning unbounded rows; read the `truncated`, `oversizedRow`, `envelopeTooLarge`, and `raw` flags before trusting a result. The `planetscale__` connection also exposes the organization, database, branch, insights, and documentation reads; its write tool is excluded at the root.

## Investigation memory (root tool)

`search_investigation_memory`, bare. Analogy only, never current truth. `available: false` is normal when the child session carries no memory stamp; record it and move on. It takes no Linear project id.

## Provider and runtime evidence (connections)

| Source | Connection | Auth class | Read boundary |
| --- | --- | --- | --- |
| Linear issues, comments, labels, documents | `linear__` | app, managed | child allowlist: `get_issue`, `list_issues`, `list_comments`, `list_issue_labels`, `get_document`, `list_documents` |
| Intercom conversations and contacts | `intercom__` | app, managed | root allowlist, reads only |
| Inngest runs, traces, functions | `inngest__` | app, managed | root allowlist, reads only |
| Lucent issues and insights | `lucent__` | app, managed | root allowlist, reads only |
| Sentry issues and events | `sentry__` | user | child allowlist: the seven confirmed read tools |
| Axiom datasets, metrics, monitors | `axiom__` | user | root allowlist, reads only |
| Vercel deployments, logs, errors, analytics | `vercel__` | user | root allowlist minus the five write tools |
| PostHog persons, recordings, errors, queries | `posthog__` | user | one `exec` tool; read-only by OAuth scope, so any write command fails at the API |
| Resend emails, logs, domains | `resend__` | user | root allowlist, reads only |
| Jam recordings, console, network | `jam__` | user | root allowlist, reads only |
| Modem customer feedback search | `modem__` | user | root allowlist: `search_modem` |
| Neon, only when the code path uses a Neon database | `neon__` | user | read-only endpoint plus root allowlist; never customer data, never memory |
| Autumn provisioning | `autumn__` | user | root allowlist, reads only |
| Stripe billing | `stripe__` | user | root allowlist, reads only |

## Billing and Instantly (root tools)

`read_autumn_billing`, `read_stripe_billing`, `list_instantly_subworkspaces`, `read_instantly_subworkspace`, all bare and app-scoped. They keep their root authorization: available on attended triage surfaces, and the billing pair only on a billing or Intercom route. `available: false` is an evidence gap, not a reason to retry.

## Screenshots (root tool)

`read_image`, bare. Loads a PNG, JPEG, GIF, or WebP from the sandbox into your context, 3 MiB limit.

## Unavailable sources

A user-scoped connection fails with `principal_required` under a service principal, which is normal for Slack intake, and with `task_mode_sign_in_unavailable` when the session's user has not authorized it. You are never shown a sign-in link and never wait for one. A managed connection can fail on operator configuration. Either way: record the lane as unavailable once, decide whether the missing evidence is material, and never ask for authorization, retry the same source, or substitute another for it.
