# Open Fin Preview baseline

This branch starts at PR #133 and restores the run dispatch, callback, result ownership and Slack receipt code from PR #137. It deliberately does not carry the restricted Fin evidence tools, custom ticket workflow, model call budget, or experimental response filtering.

The existing identity verifier establishes the user and original conversation workspace before starting Foreman. Fin sessions select the existing `foreman-fin-preview` Executor toolkit for both raw discovery/execution and authored provider helpers. Ordinary sessions continue selecting `foreman`; support retains its existing toolkit. Foreman receives the verified workspace in its instructions and investigates with ordinary capabilities.

The result endpoint reauthenticates the requesting user and binds the result to the original workspace and conversation. This protects result routing, not the contents of every provider query or generated sentence. Provider resource-level isolation and output privacy enforcement are not established by this baseline. Keep it within the existing controlled Preview audience while functional acceptance precedes guardrail work.

Configure branch-scoped `FIN_CONTEXT_ENABLED=true`, `FIN_INVESTIGATION_ENABLED=true`, `FIN_INVESTIGATION_SLACK_CHANNEL`, the existing Preview Executor/Slack connectors and private Preview database. Migration `0007_fin_investigation_runs.sql` is reused unchanged; verify it exists in that database. Production cannot enter the investigation route.

Point Start Foreman Investigation and Get Foreman Result at `/internal/fin/investigation` on this branch's Preview alias. Preserve native conversation and signed identity inputs, the saved run handle, and the Intercom ready callback. The Procedure should accept workspace investigation questions generally, then return the actual final findings. Ticket status remains paused; ticket creation uses normal Linear tools within the investigation.

Acceptance is a fresh Intercom conversation that performs a real workspace investigation through this toolkit and returns useful findings to Fin. Deployment readiness and unit tests alone do not establish that result.
