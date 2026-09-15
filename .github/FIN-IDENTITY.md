# Fin identity intake (ENG-13763)

This is the permanent identity portion extracted from Foreman PR #132. The experimental `codex/fin-foreman-preview` branch remains separate. This endpoint verifies access; it does not start an investigation or ask a model to restate identity.

## Contract

`POST /internal/fin/context` accepts exactly `{ "conversation_id": "<native Intercom conversation ID>" }` with `Authorization: Bearer <app-issued foreman_identity>`. It returns `{ status: "verified", context }` only after `verifyFinContext` validates the original conversation and contact through Executor and reauthorizes current workspace membership through Acquisity's `/api/internal/foreman/context`. Context contains canonical user/workspace IDs, workspace name/slug, owner/admin role, main-app provenance and conversation/contact identity. Responses are no-store. Credentials are not returned, logged or given to a model.

Mutable contact attributes, supplied workspace IDs and customer text cannot select authority. The native source URL identifies the requested workspace; Acquisity's live authorization grants access. Existing chats retain their original workspace across page navigation. The two fixed Intercom reads use the shared `foreman` Executor toolkit; no Preview-specific toolkit or new provider grant is introduced.

The route returns 404 unless `FIN_CONTEXT_ENABLED=true`. `ACQUISITY_FIN_ORIGIN` must be the exact HTTPS origin of the matching Acquisity deployment. Leave the flag unset in Production. Eventual enablement requires explicit rollout approval and the remaining child-ticket acceptance; merging code does not enable the entry. Missing/malformed identity returns 401, invalid request shape 400, excessive body length 413, and verification failure 403 without provider details.

## Extraction from #132

| Carry into this PR | Leave on the experimental branch |
| --- | --- |
| Native Intercom conversation/contact validation | Synthetic connection probe and marker replies |
| Live Acquisity identity/membership verification | LLM identity-only sessions and tool-blocking middleware |
| Immutable verified context and negative tests | Preview-specific toolkit and environment restrictions |
| Two fixed Executor identity reads | Slack receipts, callbacks, signed run handles and result polling |

The delivery code remains useful implementation material for ENG-13766, but is not required to verify identity. This extraction does not alter agent configuration, model selection, Slack behavior, schedules, dependencies or database schemas.

## Integration and acceptance

This endpoint is not a drop-in replacement for the experimental start/result connectors. Their question, callback and run-handle contract remains on #132. Keep those live Preview connectors unchanged while this extraction is reviewed. Test the new route with an identity-only connector mapping native `conversation.id` and the existing app-issued User token. Never copy a workspace or credential into model-authored inputs. The response is verified context, not `pending` or an investigation handle.

ENG-13764 should call the same `verifyFinContext` function before starting an investigation and carry its result through the scoped runtime. ENG-13765 enforces provider reads; ENG-13766 owns run/result binding and delivery. This response is not a reusable authorization credential: subsequent access must be reverified.

The original branch's live two-workspace checks are historical verifier evidence, not acceptance of this new route or its shared-toolkit configuration. Before closing ENG-13763, verify the final Acquisity revision and exercise this route through Fin on its exact configured Preview deployment, including concurrent workspace chats and negative authorization cases. Full investigation/pilot acceptance remains ENG-13768. Production activation is not part of this PR.
