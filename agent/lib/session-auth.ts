import type { SessionAuthContext } from "eve/context";
import { stampRepository } from "./repository.js";
import { stampSlackIntakeAuth } from "./slack-intake.js";
import { stampInvestigationMemory, stampTrusted } from "./trust.js";

/**
 * The stamp compositions the channels apply at dispatch, stated once.
 *
 * @remarks
 * The individual stamps stay where they belong: trust in `trust.ts`,
 * repository selection in `repository.ts`, the intake boundary in
 * `slack-intake.ts`. What lives here is the order and combination each channel
 * applies, which is the part anything measuring or reasoning about a session
 * lane would otherwise copy by hand and let drift. The Slack channel calls
 * this helper, so measurements use the same lane that actually dispatches.
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
