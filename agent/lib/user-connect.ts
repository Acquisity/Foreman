import { connect, type EveAuthorizationOptions } from "@vercel/connect/eve";
import {
  ConnectionAuthorizationFailedError,
  type ConnectionPrincipal,
  type InteractiveAuthorizationDefinition,
  isConnectionAuthorizationRequiredError,
} from "eve/connections";
import { INTAKE_ONLY_ATTRIBUTE } from "./trust.js";

/**
 * Reason code carried by the denial an intake-only session gets instead of a
 * sign-in prompt. Surfaces on the failed tool result and on
 * `authorization.completed`, so it is the string to grep for in logs.
 */
export const INTAKE_ONLY_SIGN_IN_REASON = "intake_only_sign_in_unavailable";

/**
 * Translates a user-scoped connection's "authorization required" signal into a
 * terminal failure when the session came from an intake-only Slack channel.
 *
 * @remarks
 * Returns undefined for every other case, so the caller rethrows the original
 * error and the normal consent flow runs unchanged.
 *
 * Slack's default `authorization.required` handler posts a public status line
 * into the thread, delivers the sign-in link ephemerally to the triggering
 * user, and the runtime then parks the turn on the OAuth callback. In a
 * developer channel that is fine: the person reading it holds the grant and
 * completing it resumes the turn. An intake-only channel is requester-facing
 * and over a hundred people wide, so the status line reads as an internal
 * error to an audience that cannot act on it, and the park leaves the request
 * unanswered forever.
 *
 * Denying instead of parking keeps the turn alive. The model loses one
 * connection, says so, and still answers or files the Linear issue. The
 * failure is stamped `retryable: false` so the runtime does not re-prompt.
 */
export function intakeOnlySignInDenial(
  error: unknown,
  principal: ConnectionPrincipal
): ConnectionAuthorizationFailedError | undefined {
  if (
    !isConnectionAuthorizationRequiredError(error) ||
    principal.type !== "user" ||
    principal.attributes?.[INTAKE_ONLY_ATTRIBUTE] !== "true"
  ) {
    return;
  }
  const name = error.connectionName;
  return new ConnectionAuthorizationFailedError(name, {
    message: `The ${name} connection needs a sign-in this session cannot ask for. The request came from an intake-only Slack channel, where nobody can complete it. Answer from what you can reach without ${name}, and say plainly which evidence you could not gather.`,
    reason: INTAKE_ONLY_SIGN_IN_REASON,
    retryable: false,
  });
}

/**
 * Vercel Connect authorization for a user-scoped connection, with the
 * intake-only denial in front of the consent flow.
 *
 * @remarks
 * Every `principalType: "user"` connection uses this instead of `connect()`
 * directly. App-scoped connections (Linear, PlanetScale, Inngest, Lucent) never
 * run a consent flow, so they need nothing here.
 *
 * The gate reads the intake-only stamp off the resolved principal, which
 * carries the dispatching session's auth attributes. Only the Slack channel and
 * the SLA schedule stamp it, and only for a channel in
 * SLACK_INTAKE_ONLY_CHANNELS, so no other surface changes behavior.
 */
export function userConnect(
  options: EveAuthorizationOptions & { readonly principalType?: "user" }
) {
  const auth = connect({ ...options, principalType: "user" });
  const wrapped: typeof auth = {
    ...auth,
    getToken: async (
      opts: Parameters<InteractiveAuthorizationDefinition["getToken"]>[0]
    ) => {
      try {
        return await auth.getToken(opts);
      } catch (error) {
        throw intakeOnlySignInDenial(error, opts.principal) ?? error;
      }
    },
  };
  return wrapped;
}
