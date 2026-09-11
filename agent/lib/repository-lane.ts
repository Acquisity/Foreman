import type { SessionAuthContext } from "eve/context";
import { repositoryFromAuth } from "./repository.js";
import { selectedRepositorySlug } from "./repository-selection.js";
import { sessionLane } from "./session-lane.js";

/**
 * Whether a session lane carries the repository tools and the GitHub tool
 * surface.
 *
 * @remarks
 * This is capability composition, not authorization. Every write these
 * capabilities perform stays gated where it already is: `agent/lib/trust.ts`
 * decides trust, `agent/lib/github/approval.ts` decides approval,
 * `intakeOnlyPolicy` denies push and pull-request creation whatever this
 * module returns, and a signed webhook still binds its session to one
 * repository. What is decided here is only whether the catalog is advertised,
 * which ordinary Slack conversation was paying for on every turn: the GitHub
 * extension alone is 31 tools and about a fifth of the model-visible catalog.
 *
 * The decision reads stamps the dispatching channel applied to the signed
 * event, and durable session state Foreman's own tool wrote, never
 * model-readable content: a dynamic tool resolver is handed an empty
 * `ctx.messages`. Every interactive channel restamps its auth on each
 * delivery, so a later message naming a repository turns the catalog on for
 * the next turn without restarting the session.
 *
 * A lane qualifies when the channel stamped a selected repository or when
 * prepare_repository recorded one in durable session state. A bare
 * `owner/repo` slug in free text stamps no repository (see
 * `extractRepositoryUrls`), so a Slack request to open a pull request in a
 * repository named that way used to prepare the checkout and then find neither
 * the repository tools nor the GitHub surface, on that turn or any later one.
 * eve re-resolves dynamic tools per step with the context active, so the
 * recorded selection turns the catalog on for the next step of the same turn.
 * That holds only while every resolver behind this gate runs at
 * `step.started`, the four repository tools under `agent/tools/` as much as the
 * GitHub surface: eve resolves `turn.started` once, before the turn's first
 * tool runs, which is before `prepare_repository` can have recorded anything.
 * A resolver moved back to `turn.started` would answer null for the whole turn
 * and leave the lane able to open a pull request it cannot push a branch for.
 *
 * The state read cannot be allowed to throw: eve drops a failed resolver's
 * whole result, which would take the entire GitHub surface down with it, so
 * {@link selectedRepositorySlug} degrades to null and this falls back to the
 * auth-only answer.
 *
 * Deliberately not gated: `prepare_repository` is the door, and the tool has
 * to be there for the model to pass it the slug it read out of the request.
 * `rebuild_warm_snapshot` is warm-up operations rather than work on a selected
 * repository, and needs none.
 */
export const repositoryCapabilitiesAvailable = (
  auth: SessionAuthContext | null,
  {
    initiator = auth,
    readOnly = false,
  }: { initiator?: SessionAuthContext | null; readOnly?: boolean } = {}
): boolean =>
  (readOnly || sessionLane(initiator).repository) &&
  (repositoryFromAuth(auth) !== null || selectedRepositorySlug() !== null);
