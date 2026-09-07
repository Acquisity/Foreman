import type { InteractiveAuthorizationDefinition } from "eve/connections";
import type { ToolAuthProvider } from "eve/tools";
import supermemory from "../connections/supermemory.js";
import { consentAuth } from "./user-connect.js";

export interface SignInAuth {
  readonly consent: InteractiveAuthorizationDefinition;
  readonly wrapped: ToolAuthProvider;
}

/** Personal Supermemory is the only retained per-user provider sign-in. Company-service accounts are operated through Executor. */
const CONNECTIONS: Readonly<Record<string, { auth?: unknown }>> = {
  supermemory,
};

/**
 * Connection names `sign_in` accepts, sorted for the input schema.
 */
export const SIGN_IN_CONNECTIONS = Object.keys(CONNECTIONS).sort() as [
  string,
  ...string[],
];

/**
 * Resolves the wrapped and consent authorizations for one named
 * user-scoped connection, or undefined when the name is unknown or the
 * connection does not carry per-user sign-in.
 */
export function signInAuth(connection: string): SignInAuth | undefined {
  const definition = CONNECTIONS[connection];
  const consent = consentAuth(definition?.auth);
  if (!(definition?.auth && consent)) {
    return;
  }
  // consentAuth only resolves for a `userConnect` definition, which is an
  // interactive tool auth provider.
  return { consent, wrapped: definition.auth as ToolAuthProvider };
}
