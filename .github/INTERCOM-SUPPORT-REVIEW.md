# Support branch review response

Review base: `92b663e..6a0c054`. Rollout verification and migrations are still required before enabling the schedules.

| Finding | Resolution |
| --- | --- |
| 1. Executor layer inversion | Added Executor-owned dispatch for tools, typed helpers and schema discovery. Support supplies its policy and persistence callbacks. Dispatch owns operation admission, authorization order and write-journal execution. The raw invocation function is private; an architecture regression check restricts the internal wire adapter to dispatch and wire tests. |
| 2. Scattered lane checks | Added one session-lane composition selector for root/critic discovery, prompt additions, broad Executor availability and the repository gate. The GitHub resolver delegates its decision to the existing repository-lane module. Read-only repository evidence remains available after selection, preserving investigation usefulness. |
| 3. Prompt substring replacement | Prompt assembly accepts discovery and additional instructions directly. Removed supportSystemPrompt and string replacement. Ordinary general/factory prompt behavior is regression-tested. |
| 4. Fake Slack parser input | Extracted bounded intercomConversationIds text parsing; notification provenance stays in its own wrapper. Linear matching uses the pure parser. |
| 5. State-machine flags | Added a pure discriminated decision function and table-driven tests. Settlement uses named closed/processed options. |
| 6. Repeated case reads and hidden writes | Finish passes its fresh observation into delivery. Outbox retries still read fresh evidence. Journal recovery runs explicitly during open, outside Linear evidence reads. |
| 7. Lease mutation consistency | Ordinary state writes use atomic lease predicates, RETURNING and explicit conflicts. Idempotent journal replay is distinguished from a new reservation. Late provider receipts deliberately use reservation ownership instead of current case-lease validity, preventing a lost response from becoming a duplicate retry. Added migration 0005 and stale-write/receipt tests. |
| 8. Root checks | claimFromContext accepts an optional session. The shared requireSupportContext owns root-only validation. |
| 9. Weak enums | One creationRole schema/type is shared by the tool and issue helpers. Toolkit constants/types live with the endpoint. Retained runtime validation at the URL boundary as defense against malformed runtime input. |
| 10. Refusal versus outage | SupportRefusal returns to the model without Slack delivery or lease release. Infrastructure failures retain bounded failure reporting. The PostgreSQL smoke test exercises the actual tool refusal path. |
| 11. Shared constants/DB transport | Reused Engineering's team constant and centralized the support enable check and Intercom workspace. Extracted private Postgres client construction while keeping store schemas and authorization separate. |
| 12. Bespoke DB driver | Replaced shell execution, SQL interpolation, CSV parsing and the OID table with pg, parameterized queries and driver-supplied field metadata. Tests require a loopback foreman_support_test database. |
| Minor lifecycle behavior | Normal completion checks for a remaining lease explicitly instead of using an expected exception as its success path. |

The meaningful behavioral corrections are that model-correctable refusals stay in the active investigation and stale state writes now report conflicts. Quiet follow-up semantics, shared investigative access, original-thread delivery and disabled-by-default rollout remain intact.

Historical validation of `6fe068e`: `pnpm validate` passed with 682 tests, `pnpm build` passed, and the disposable PostgreSQL smoke test passed through the `pg` adapter. This includes refusal handling without Slack delivery, rejection of stale state writes, and reservation-owned late receipts. No production migration, live provider write, deployment, push or PR was performed.

The approval review's three follow-ups are also addressed:

- Pending failure delivery uses a separate predicate. The decision function requires an observation and carries no sentinel read state or unreachable fallback.
- Open loads the case and operation journal once and passes them through recovery and evidence helpers. Recovery returns the updated watch list for immediate use. Provider dispatch still checks the live lease, and state writes retain their atomic fences.
- Authorization returns the case version explicitly to dispatch, which passes it into write-key calculation. The policy retains no mutable authorization state.

Historical validation of `73e24c9` after these follow-ups: `pnpm validate` passed with 682 tests, `pnpm build` passed, and the real PostgreSQL smoke test passed. These are local checks; production rollout gates remain unchanged.

Later bot-review fixes and their current validation are recorded on PR #119. The counts above describe those historical commits, not subsequent revisions.
