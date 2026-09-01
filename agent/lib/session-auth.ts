import type { SessionAuthContext } from "eve/context";
import { stampRepository } from "./repository.js";
import { stampSlackIntakeAuth } from "./slack-intake.js";
import {
  stampAutonomous,
  stampInvestigationMemory,
  stampTrusted,
} from "./trust.js";

/**
 * The stamp compositions the channels apply at dispatch, stated once.
 *
 * @remarks
 * The individual stamps stay where they belong: trust in `trust.ts`,
 * repository selection in `repository.ts`, the intake boundary in
 * `slack-intake.ts`. What lives here is the order and combination each channel
 * applies, which is the part anything measuring or reasoning about a session
 * lane would otherwise copy by hand and let drift. `agent/channels/slack.ts`
 * and `agent/channels/github.ts` call these helpers, so a lane described
 * anywhere else describes the lane that actually dispatches.
 */

/**
 * The auth a Slack dispatch runs under.
 *
 * @param auth - eve's projected Slack author, from `defaultSlackAuth`.
 * @param options - `repository` when the message named exactly one GitHub URL,
 * and whether the channel is intake-only.
 */
export const slackSessionAuth = (
  auth: SessionAuthContext,
  options: {
    readonly intakeOnly: boolean;
    readonly repository?: string | undefined;
  }
): SessionAuthContext => {
  const trusted = stampTrusted(auth);
  const withRepository = options.repository
    ? stampRepository(trusted, options.repository, "explicit")
    : trusted;
  // Investigation memory follows the same gate as trust here: the app is only
  // invited into Acquisity channels, so channel membership is the boundary.
  const stamped = stampInvestigationMemory(withRepository);
  return options.intakeOnly ? stampSlackIntakeAuth(stamped) : stamped;
};

/**
 * The auth an unattended factory run dispatched from a signed GitHub webhook
 * runs under.
 *
 * @param auth - eve's projected webhook sender, from `defaultGitHubAuth`.
 * @param repository - the webhook's own `owner/repo`, the only authority that
 * binds a run to one repository.
 * @param issue - the issue or pull request number the run was dispatched from.
 *
 * @remarks
 * The sender's identity is replaced by {@link stampAutonomous}, so the run
 * never executes as the labeler or commenter, and the caller is never stamped
 * trusted: an unattended run gets what `isAutonomous` allows, not what a
 * trusted person may write.
 */
export const githubFactoryAuth = (
  auth: SessionAuthContext,
  repository: string,
  issue: number
): SessionAuthContext =>
  stampAutonomous(stampRepository(auth, repository, "github-webhook"), issue);
