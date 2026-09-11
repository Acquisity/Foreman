# ENG-13737 implementation handoff

## PR2 handoff: upgrade Eve

Pin Eve 0.54.2 and GitHub extension 0.7.1. Use an official browser extension release whose compiled contracts Eve 0.54.2 accepts. Registry latest @agent-browser/eve 0.37.1 still declares unsupported tool contract 21 despite its broad peer range. Track upstream https://github.com/vercel-labs/agent-browser/issues/1841; do not fork, rebuild or bypass compatibility checks.

Observed original-checkout typecheck failures: 12 removed glob/grep factories (four remain after PR1), removed ApprovalContext/ApprovalStatus exports, delta-only reasoningSoFar removal, new workflow-tool-call action variant, and sleep's WorkflowToolContext mismatch. Plain eve info first failed for missing LINEAR_CONNECTOR; after loading .env.example it failed on defineGlobTool. Do not report either as runtime validation. Full output is preserved.

Review `agent/agent.test.ts` against the installed target runtime: its private `resolveRuntimeModelSelection` import and live-step assertions deliberately expose internal API drift. Verify the path and signature, preserve the wrapped-model and routing regression coverage, and update the 0.44.0 comment. A failure on 0.54.2 has not been observed for this newly added test.

Read installed target docs for tools/HITL, dynamic capabilities, subagents, sandbox, Slack, hooks, skills, connections and evals before edits. Migrate glob/grep default imports; approval types from their current public exports; sleep to the supported workflow/tool contract. Extend Slack action narrowing for the actual event union, not an unchecked cast.

Update capability reader from compiled manifest 41 to 48 and distinguish application/framework/extension ownership; preserve comparable catalog measurements and actual dynamic admission. Replace removed authored-module preparation helper with prepareAuthoredRuntimeModules and derive fixed delegation schema through current agent contract/schema exports. Remove experimental persistent-session branching and use fresh turnId/stepIndex in dispatch fixtures.

Accumulate reasoningDelta by channel state plus turn/step, clearing at lifecycle boundaries. Preserve progress timing and delivery behavior. Keep root wrapped model resolution at step.started and verify its runtime path.

Eve 0.54 delegation is persistent/background: launch receipts are not completion. Verify critic/vision completion delivery, overlapping task cohorts, user follow-ups, and support lease/journal completion only after results. Update eval observation to follow later turns/streams with bounded cancellation. Slack stop requests tasks:true on the resolved session with the latest observed turnId, including a parent waiting on children; accepted means request accepted, not stopped. Acknowledge once as "Stop requested.", keep no-active-turn quiet, verify actual child settlement, and do not add a custom task tracker or polling loop.

## Workaround and proposal decisions

| Behavior / changelog | Decision |
| --- | --- |
| Approval independence, 0.50.0 | Use native pending-approval independence; keep Foreman trust, intake denials, requireApproval:false and Slack consent handling. Native transport still needs live proof. |
| Compaction provider-reported tokens, 0.52.3 | Keep thresholdPercent 0.75 and maxInputTokensPerSession:false; improved accounting does not change the product choice to avoid Slack quota cards. |
| Session token-cost limit, 0.51.1 | Leave unset, as output cap is unset. Do not introduce a new budget prompt. |
| Slack long replies as snippets, 0.53.1 | Keep authored chunking for this upgrade; defer native snippet adoption until files:write and format/failure behavior are verified. Custom message.completed bypasses the native path. |
| Hook throws, 0.52.3 | Keep support's authored hook bound and nonthrowing ops logger. Conversation failures can wait for another turn; adapter exceptions are still swallowed. |
| Queued delivery full-auth batching, 0.52.5 | Use native batching, preserve every channel auth stamp and queue policy. |
| Background forced-silence fix, 0.52.5 | Use native fix; retain intake-only quiet rules because they are intentional workflow behavior. |
| Dynamic callback name/phase identity, 0.44.1; session/resolver isolation, 0.52.3 | Keep stable callback carriers and GitHub gate through migration; defer optional carrier simplification until the compiled proof passes. |
| Native ask_question | Keep disabled. Wrapped Slack closed-option replies still do not match; freeform replies include the wrapper. A live button/answer roundtrip has not been verified. |

EVE-PROPOSALS: native same-slot built-in dynamic replacement and dynamic connections are available; do not introduce duplicate substitutes. Whole-extension gating, separate-file null suppression, custom delegation schemas, lifecycle duration fields and hard per-run deadlines remain unsupported or do not solve the recorded requirement. Preserve the receive-only route behavior and support journals. Reassess remaining proposals against the installed target, remove factory-only requests, and mark historical assumptions explicitly.

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

## Evidence still required

At spike completion no live Preview configuration, Slack interaction, provider grant, child sandbox dispatch, scratch-repo write or built GitHub proof has passed for these changes. These remain release gates. The official browser release remains an external gate for PR2. No claim that info/build success establishes runtime readiness.

Start from main after ENG-13736 is accepted and merged with Aaron's approval. Branch codex/eng-13737-eve-0542. Estimate 2.5 days plus upstream browser release wait. Do not start this slice while the first PR awaits Aaron's testing.
