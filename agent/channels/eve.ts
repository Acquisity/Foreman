import type { UserContent } from "ai";
import { type AuthFn, localDev, vercelOidc } from "eve/channels/auth";
import {
  defaultEveAuth,
  type EveMessageContext,
  type EveMessageResult,
  eveChannel,
} from "eve/channels/eve";
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
 * Stamps exactly one full GitHub URL from the delivered text. A bare slug may
 * be a file path, so only prepare_repository can deliberately select one.
 * Route authentication remains unchanged for local and production sessions.
 */
const messageText = (message: string | UserContent): string =>
  typeof message === "string"
    ? message
    : message
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");

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
    auth: withRepository,
  };
};

export default eveChannel({ auth: [localDevUser, vercelOidc()], onMessage });
