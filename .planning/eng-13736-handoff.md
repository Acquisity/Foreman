# ENG-13736 implementation handoff

## PR1 handoff: remove factory

Delete classifier, investigator, analyst, implementer, reviewer, researcher; factory prompts, intent matching/stamps, factory-pipeline skill, labels, CI/review/PR synchronization automation, pipeline state/tools, artifact handoffs, branch-prefix ownership config and factory-only evals. Remove automatic PR-open summaries. Restore the native agent tool by deleting its disable sentinel. Retain critic/vision and model slots orchestrator/critic/vision. Unknown retired stored model keys already need no migration.

Preserve signed repository authority, trust/intake-only/publication restrictions, safe repository switching, protected branches, shared Executor access, operational schedules and support journals. Historical repository-knowledge reads may still use their old storage prefix; preserve that compatibility and old object protection without retaining factory execution. Retired unattended identities must not acquire attended permissions.

Simplify repository capability availability to selected/stamped/prepared repository with existing support restrictions. Keep step.started timing so prepare_repository exposes tools on the next step. Keep all 31 GitHub tools, seven override entries, two stamped carrier objects and three exported callbacks. Preserve the shared human PR-readiness restriction separately from deleted factory readiness state.

Update capability measurement, current documentation and evals for the smaller agent. General native delegation receives self-contained tasks and non-overlapping write scopes in its shared sandbox. No replacement coordinator, dormant factory subsystem or future factory skill.

Compile break: none from dependency versions; remove references to deleted station/pipeline/factory exports. Runtime changes: no factory activation or automatic GitHub work; ordinary delegation becomes native Eve 0.44 one-shot copies. Verify inherited auth/sandbox and parent cancellation through real dispatch.

## Verification and Preview procedure for each PR

Run pnpm validate with zero errors/warnings, pnpm build, capability report, relevant repository/authorization/support tests, and the compiled GitHub proof. Read the UAT battery from the existing UAT branch (PR115) as reference; replace obsolete factory scenarios with direct scratch-repo work and native delegation.

Before any Preview smoke:
1. Identify the Foreman Preview Slack connector live. Set its trigger branch to the current PR branch and remove the previous branch trigger. Remove the old routing rule, not the git branch or connector.
2. Ensure the Preview Executor app connector is attached. Set branch-scoped EXECUTOR_MCP_CONNECTOR to its verified UID, EXECUTOR_BASE_URL=https://executor.acquisity.ai and EXECUTOR_OPERATION_BINDINGS to compact verified .github/executor/operation-bindings.json. The {} example is not runnable provider configuration.
3. Redeploy the exact commit after environment changes. Read back branch/connector/env metadata without exposing credentials. Record commit, deployment ID and test thread links.
4. Run contract/readiness metadata checks and a real small Executor read through the Preview bot. Metadata readiness alone does not prove provider grants.
5. Keep support Preview queues in a separate private database; do not enable a Preview against production's operational queue.

Per-slice real smoke: Slack Q&A, Slack image attachment/vision, intake-only investigation with denied publication, direct prepare/edit/push/PR on a scratch repo, critic independent read, two delegated tasks, completion delivery and cancellation. Verify ordinary Slack excludes GitHub until repository selection; next step after preparation exposes all 31. Verify labels, checks, PR openings and non-mentioned reviews trigger no work. For PR2 additionally test background receipts versus settlement, cohort delivery, queued auth separation and stop while waiting.

Mandatory built GitHub proof:
```sh
set -a; . ./.env.example; set +a
pnpm build
node scripts/verify-built-github.mjs
```
The script must boot/import .output/server/index.mjs and then import .output/server/_libs/@github-tools/eve-extension.mjs in the same process so configuration registers. Call t.default.events["step.started"](), require exact allowlist equality and count 31, and validate every entry through validateDurableDynamicToolCallbacks from eve/dist/src/context/dynamic-tool-lifecycle.js. On 0.54 pass owner { sessionId, scope:"step", resolverSlug, entryKey, name } with qualified name. Prove mounted gate exclusion/admission and reject an unstamped negative fixture. Do not execute provider mutations in the structural proof.

Aaron tests each PR before the next opens. Production deploys main only after explicit merge approval. Rollback is a revert commit on main followed by deployment and fresh-session smoke, never vercel rollback. Do not promise reverse compatibility for pre-existing durable sessions without testing.


Current branch: codex/eng-13736-remove-factory. Dependencies remain locked to Eve 0.44.0. The first PR is the only PR authorized to open before Aaron's testing. Estimate 2.5 days including smoke.

No retired factory execution is retained. Historical data prefixes and retired-principal denials are compatibility protections only. No data deletion/migration.
