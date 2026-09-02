import type { UserContent } from "ai";
import { type AuthFn, localDev, vercelOidc } from "eve/channels/auth";
import {
  defaultEveAuth,
  type EveMessageContext,
  type EveMessageResult,
  eveChannel,
} from "eve/channels/eve";
import { isFactoryRequest, stampFactoryIntent } from "../lib/factory-lane.js";
import { extractRepositoryUrls, stampRepository } from "../lib/repository.js";
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
 * Reads explicit factory intent and repository selection out of the delivered
 * eve message.
 *
 * @remarks
 * eve is an interactive lane, so it can ask for the factory and name a
 * repository the same way Slack and Linear do, and this hook is the only place
 * that sees the delivered text: a dynamic resolver runs at `turn.started`,
 * where eve hands it an empty message snapshot. Route auth stays where it is;
 * this only adds the stamps, which is why it applies to the dev TUI and to a
 * production `vercelOidc()` session alike rather than being a dev-only shim.
 *
 * URLs only, and exactly one, matching `agent/channels/slack.ts` and
 * `agent/channels/linear.ts`: a bare `owner/repo` token cannot be told apart
 * from a file path like `channels/github.ts`, and stamping one would bind the
 * session to a repository that does not exist. Without this stamp the eve lane
 * would have no way to select a repository at all, and
 * `repositoryCapabilitiesAvailable` would leave it permanently without the
 * repository and GitHub catalogs rather than until it asked for them.
 */
const messageText = (message: string | UserContent): string =>
  typeof message === "string" ? message : JSON.stringify(message);

export const onMessage = (
  ctx: EveMessageContext,
  message: string | UserContent
): EveMessageResult => {
  const auth = defaultEveAuth(ctx);
  if (!auth) {
    return { auth };
  }
  const repositories = extractRepositoryUrls(messageText(message));
  const [repository] = repositories;
  const withRepository =
    repositories.length === 1 && repository
      ? stampRepository(auth, repository.slug, "explicit")
      : auth;
  return {
    auth: isFactoryRequest(message)
      ? stampFactoryIntent(withRepository)
      : withRepository,
  };
};

export default eveChannel({ auth: [localDevUser, vercelOidc()], onMessage });
