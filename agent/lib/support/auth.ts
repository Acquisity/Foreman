import type { SessionAuthContext, SessionContext } from "eve/context";
import { z } from "zod";
import { stampIntakeOnly, stampUnattended } from "../trust.js";
import { conversationId, slackTimestamp } from "./config.js";

export const supportClaim = z.object({
  conversation: conversationId,
  lease: z.uuid(),
  thread: slackTimestamp,
});
export type SupportClaim = z.infer<typeof supportClaim>;
const ISSUER = "foreman:intercom-support";

export function supportAuth(auth: SessionAuthContext, claim: SupportClaim) {
  return stampIntakeOnly(
    stampUnattended({
      ...auth,
      attributes: { ...auth.attributes, ...supportClaim.parse(claim) },
      issuer: ISSUER,
    })
  );
}

export function isSupportAuth(auth: SessionAuthContext | null | undefined) {
  return auth?.issuer === ISSUER;
}

/** Initiator identity survives delegation; per-session state does not. */
export function claimFromContext(ctx: {
  session: { auth: SessionContext["session"]["auth"] };
}): SupportClaim | null {
  const auth = ctx.session.auth.initiator;
  return isSupportAuth(auth) ? supportClaim.parse(auth?.attributes) : null;
}
