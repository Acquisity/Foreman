import type { SessionAuthContext } from "eve/context";
import { factorySkillAvailable } from "./factory-lane.js";
import { repositoryFromAuth } from "./repository.js";

/**
 * Whether a session lane carries the repository tools and the GitHub tool
 * surface.
 *
 * @remarks
 * This is capability composition, not authorization, and it is the same
 * distinction {@link factorySkillAvailable} draws. Every write these
 * capabilities perform stays gated where it already is: `agent/lib/trust.ts`
 * decides trust, `agent/lib/github/approval.ts` decides approval,
 * `intakeOnlyPolicy` denies push and pull-request creation whatever this
 * module returns, and a signed webhook still binds its session to one
 * repository. What is decided here is only whether the catalog is advertised,
 * which ordinary Slack conversation was paying for on every turn: the GitHub
 * extension alone is 31 tools and about a fifth of the model-visible catalog.
 *
 * The decision reads stamps the dispatching channel applied to the signed
 * event, never model-readable content, because a dynamic tool resolver is
 * handed an empty `ctx.messages`. Every interactive channel restamps its auth
 * on each delivery, so a later message naming a repository turns the catalog
 * on for the next turn without restarting the session.
 *
 * A lane qualifies when it has a selected repository, or when it could take
 * the factory path at all. The second clause is not redundant: the factory
 * skill is offered on explicit intent alone, and a lane that can load the
 * station procedure has to be able to run it. Reusing
 * {@link factorySkillAvailable} rather than restating its conditions also
 * keeps the intake-only rule in one place, where explicit intent counts only
 * from a trusted caller.
 *
 * Deliberately not gated: `prepare_repository` is the door. A bare
 * `owner/repo` token in free text stamps no repository (see
 * `extractRepositoryUrls`), so the model reads the slug out of the request and
 * passes it to that tool, and the tool has to be there for it to do so.
 * `rebuild_warm_snapshot` is warm-up operations rather than work on a selected
 * repository, and needs none.
 */
export const repositoryCapabilitiesAvailable = (
  auth: SessionAuthContext | null
): boolean => repositoryFromAuth(auth) !== null || factorySkillAvailable(auth);
