# Fin customer investigations

Fin starts customer investigations through `POST /internal/fin/investigation`. The route is Preview-only and returns `404` in Production even when `FIN_INVESTIGATION_ENABLED=true`.

The start request carries `action=start`, the native Intercom conversation id, the customer's question, and an optional Intercom procedure callback URL. Foreman resolves the bearer token through Acquisity's fixed `/api/internal/foreman/context` endpoint and persists only that server-verified context in the session initiator. Caller-supplied workspace, organization, user, role, or origin fields are rejected.

Customer investigations are a separate capability lane. The verified organization scope is immutable across later turns and native delegation. The lane exposes native delegation, cancellation, and one ticket-filing tool whose Linear team, assignee, conversation, and workspace are fixed from server-owned context. It denies raw and authored Executor dispatch, removes repository, browser, memory, model-control, critic, and vision instructions, and starts its sandbox with a deny-all network policy. These restrictions intentionally leave provider reads and every other Linear operation unavailable until ENG-13765 and ENG-13769 add their scoped interfaces.

## Preview configuration

Set these only on the PR's Preview branch:

```text
ACQUISITY_FIN_ORIGIN=https://app.acquisity.ai
FIN_CONTEXT_ENABLED=true
FIN_INVESTIGATION_ENABLED=true
FOREMAN_SUPPORT_ENABLED=false
FOREMAN_SUPPORT_FOLLOWUPS_ENABLED=false
```

Keep the existing Executor connector and base URL from the Preview setup. `FIN_INVESTIGATION_SLACK_CHANNEL` is optional and posts a receipt to the existing Preview Slack connector when configured. The Intercom Fin audience remains an exact OR match for the approved test emails. Do not enable or exercise human handoff during this slice because the Production support scanner exclusion is not part of this ticket.

## Run ownership and recovery

See [FIN-RUN-OWNERSHIP.md](./FIN-RUN-OWNERSHIP.md) for the current `action=start` / `action=result` contract. Result reads require the native conversation ID, saved `run_handle`, and a fresh identity Bearer token. Configure `FOREMAN_MEMORY_DATABASE_URL` to the isolated private Preview database and manually apply migration `0007_fin_investigation_runs.sql` before enabling the entry. Deployment does not apply migrations. Pending retrieval failures carry only the recovery reference; they do not authorize another investigation. Callback notifications contain no findings.

The Fin entry remains disabled pending customer acceptance. The earlier capability description predates ENG-13765; scoped evidence reads are now available through that slice, while unrestricted provider access stays denied. Do not treat the configuration example above as approval to enable the entry.
