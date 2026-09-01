import { type AuthFn, localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { stampFactoryIntent } from "../lib/factory-lane.js";
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
 * stamps neither attribute.
 *
 * It carries factory intent for the same dev-only reason. The dev TUI delivers no
 * channel text this shim can read, and both execution paths have to be exercisable
 * from `pnpm dev`, so the local session is the one surface that always sees the
 * factory skill. Production eve sessions resolve through `vercelOidc()` and do not.
 */
const localDevUser: AuthFn<Request> = async (request) => {
  const local = await localDevAuth(request);
  return local
    ? stampFactoryIntent(
        stampInvestigationMemory({ ...local, principalType: "user" })
      )
    : null;
};

export default eveChannel({ auth: [localDevUser, vercelOidc()] });
