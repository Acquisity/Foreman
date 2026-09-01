import type { UserContent } from "ai";
import { type AuthFn, localDev, vercelOidc } from "eve/channels/auth";
import {
  defaultEveAuth,
  type EveMessageContext,
  type EveMessageResult,
  eveChannel,
} from "eve/channels/eve";
import { isFactoryRequest, stampFactoryIntent } from "../lib/factory-lane.js";
import { stampInvestigationMemory } from "../lib/trust.js";

const localDevAuth = localDev();

/**
 * Dev-only: present a trusted local session as an authenticated user.
 *
 * @remarks
 * The user-preference tools key their storage on a `principalType: "user"` session. In
 * production the channels supply one; the eve dev TUI authenticates with `localDev()`,
 * whose `local-dev` principal is not a user, so user-scoped tool calls fail with
 * `principal_required`. This shim defers the trust decision to `localDev()` — returning `null`
 * for anything it would reject, so it never affects production — and only upgrades the resolved
 * principal to a user. Drop it if you don't exercise user-scoped tools from the dev TUI.
 *
 * It is also the development-only path into investigation memory: the dev TUI is the
 * one surface where a person can exercise the memory tools without a Linear Agent
 * Session or a routed Slack channel. `localDev()` only resolves against a local
 * request, so nothing here reaches production, where `vercelOidc()` runs instead and
 * stamps neither the user principal nor the memory attribute.
 */
const localDevUser: AuthFn<Request> = async (request) => {
  const local = await localDevAuth(request);
  return local
    ? stampInvestigationMemory({ ...local, principalType: "user" })
    : null;
};

/**
 * Reads explicit factory intent out of the delivered eve message.
 *
 * @remarks
 * eve is an interactive lane, so it can ask for the factory the same way Slack
 * and Linear do, and this hook is the only place that sees the delivered text:
 * a dynamic skill resolver runs at `turn.started`, where eve hands it an empty
 * message snapshot. Route auth stays where it is; this only adds the stamp,
 * which is why it applies to the dev TUI and to a production `vercelOidc()`
 * session alike rather than being a dev-only shim.
 */
export const onMessage = (
  ctx: EveMessageContext,
  message: string | UserContent
): EveMessageResult => {
  const auth = defaultEveAuth(ctx);
  return {
    auth: auth && isFactoryRequest(message) ? stampFactoryIntent(auth) : auth,
  };
};

export default eveChannel({ auth: [localDevUser, vercelOidc()], onMessage });
