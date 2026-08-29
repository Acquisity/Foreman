import type { EveAuthorizationOptions } from "@vercel/connect/eve";
import {
  type ConnectionAuthDefinition,
  ConnectionAuthorizationFailedError,
  type ConnectionPrincipal,
  type InteractiveAuthorizationDefinition,
  isConnectionAuthorizationFailedError,
  isConnectionAuthorizationRequiredError,
} from "eve/connections";
import { managedConnect } from "./managed-connect.js";

/**
 * Reason code carried by the denial a Slack-issued session gets instead of a
 * sign-in prompt. Surfaces on the failed tool result and on
 * `authorization.completed`, so it is the string to grep for in logs.
 */
export const SLACK_SIGN_IN_REASON = "slack_sign_in_unavailable";

/**
 * Reason code carried by the denial a task-mode child gets instead of a
 * sign-in prompt, whatever session it runs under.
 */
export const TASK_MODE_SIGN_IN_REASON = "task_mode_sign_in_unavailable";

/**
 * Translates a user-scoped connection's "authorization required" signal into a
 * terminal failure when the session's user principal came from Slack.
 *
 * @remarks
 * Returns undefined for every other case, so the caller rethrows the original
 * error and the normal consent flow runs unchanged. Linear Agent Sessions,
 * local eve sessions, and app principals all keep it.
 *
 * Slack's default `authorization.required` handler posts a public status line
 * into the thread, delivers the sign-in link ephemerally to the triggering
 * user, and the runtime then parks the turn on the OAuth callback. A parked
 * Slack turn leaves the request unanswered while the runtime waits, and an
 * unattended Slack principal such as the SLA schedule's has nobody who could
 * sign in at all. Every Slack-issued user principal gets the denial, not only
 * intake-only channels: the park, not the audience, is the failure.
 *
 * Denying instead of parking keeps the turn alive. The model continues from
 * the evidence it has without narrating the connection failure. The failure
 * is stamped `retryable: false` so the runtime does not re-prompt.
 */
export function slackSignInDenial(
  error: unknown,
  principal: ConnectionPrincipal
): ConnectionAuthorizationFailedError | undefined {
  if (
    !isConnectionAuthorizationRequiredError(error) ||
    principal.type !== "user" ||
    !principal.id.startsWith("slack:")
  ) {
    return;
  }
  const name = error.connectionName;
  return new ConnectionAuthorizationFailedError(name, {
    message:
      "An optional evidence source is unavailable for this turn. Continue without retrying it. In the reply, state only any product fact that remains unconfirmed, and omit the gap when it changes no conclusion or next step.",
    reason: SLACK_SIGN_IN_REASON,
    retryable: false,
  });
}

/**
 * Vercel Connect authorization for a user-scoped connection, with the
 * Slack sign-in denial in front of the consent flow.
 *
 * @remarks
 * Every `principalType: "user"` connection uses this instead of `connect()`
 * directly. App-scoped connections (Linear, PlanetScale, Inngest, Lucent) never
 * run a consent flow, so they need nothing here.
 *
 * The gate recognizes a Slack-issued user principal by the `slack:` prefix on
 * the resolved principal id, which carries the dispatching session's auth
 * principal id. The Slack channel and the SLA schedule both build that shape,
 * so every Slack session, intake-only or not, gets the denial while no other
 * surface changes behavior.
 */
export function userConnect(
  options: EveAuthorizationOptions & { readonly principalType?: "user" }
) {
  const auth = managedConnect({ ...options, principalType: "user" });
  const wrapped: typeof auth = {
    ...auth,
    getToken: async (
      opts: Parameters<InteractiveAuthorizationDefinition["getToken"]>[0]
    ) => {
      try {
        return await auth.getToken(opts);
      } catch (error) {
        throw slackSignInDenial(error, opts.principal) ?? error;
      }
    },
  };
  return wrapped;
}

/**
 * The same authorization, with every sign-in prompt turned into a terminal
 * failure.
 *
 * @remarks
 * For a user-scoped connection mounted in a task-mode child such as the
 * critic. A child cannot park on a consent flow: nothing can answer it, so
 * the runtime waits until the parent cancels. The grant either already exists
 * for the session's principal, or the source is unavailable for this review.
 * The wrapped definition keeps the root's `evict`, `principalType`, and
 * Connect configuration, so the credential path is unchanged; only the
 * "authorization required" signal is translated, and it is stamped
 * `retryable: false` so the runtime does not re-prompt.
 */
export function withoutConsent(
  auth: ConnectionAuthDefinition | undefined
): InteractiveAuthorizationDefinition {
  if (
    typeof auth !== "object" ||
    auth === null ||
    !("getToken" in auth) ||
    typeof auth.getToken !== "function" ||
    auth.principalType !== "user"
  ) {
    throw new Error(
      "withoutConsent wraps a user-scoped interactive Connect authorization; nothing else needs it."
    );
  }
  const inner = auth as InteractiveAuthorizationDefinition;
  return {
    ...inner,
    getToken: async (
      opts: Parameters<InteractiveAuthorizationDefinition["getToken"]>[0]
    ) => {
      try {
        return await inner.getToken(opts);
      } catch (error) {
        throw taskModeSignInDenial(error) ?? error;
      }
    },
  };
}

/**
 * Translates a missing grant into the task-mode denial, or returns undefined
 * so the caller rethrows anything else unchanged.
 *
 * @remarks
 * The wrapped definition is usually `userConnect`, whose Slack gate runs
 * first and has already turned the same missing grant into its own denial by
 * the time this sees it. Both forms are the same condition for a child, so
 * both get the task-mode reason and wording.
 */
function taskModeSignInDenial(
  error: unknown
): ConnectionAuthorizationFailedError | undefined {
  const missingGrant =
    isConnectionAuthorizationRequiredError(error) ||
    (isConnectionAuthorizationFailedError(error) &&
      error.reason === SLACK_SIGN_IN_REASON);
  if (!missingGrant) {
    return;
  }
  return new ConnectionAuthorizationFailedError(error.connectionName, {
    message:
      "This evidence source is not authorized for this review. Record it as unavailable once, decide whether the missing evidence is material, and continue without retrying it.",
    reason: TASK_MODE_SIGN_IN_REASON,
    retryable: false,
  });
}
