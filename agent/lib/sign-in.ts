import type { InteractiveAuthorizationDefinition } from "eve/connections";
import type { ToolAuthProvider } from "eve/tools";
import autumn from "../connections/autumn.js";
import axiom from "../connections/axiom.js";
import exa from "../connections/exa.js";
import jam from "../connections/jam.js";
import modem from "../connections/modem.js";
import neon from "../connections/neon.js";
import openrouter from "../connections/openrouter.js";
import posthog from "../connections/posthog.js";
import resend from "../connections/resend.js";
import sentry from "../connections/sentry.js";
import stripe from "../connections/stripe.js";
import supermemory from "../connections/supermemory.js";
import vercel from "../connections/vercel.js";
import { consentAuth } from "./user-connect.js";

/**
 * The two authorization faces of one user-scoped connection: the wrapped
 * definition the connection itself uses (with the Slack sign-in denial in
 * front of the consent flow), and the unwrapped definition that still
 * starts consent, kept by {@link consentAuth}.
 */
export interface SignInAuth {
  readonly consent: InteractiveAuthorizationDefinition;
  readonly wrapped: ToolAuthProvider;
}

/**
 * Every user-scoped connection, keyed by its path-derived connection name.
 *
 * @remarks
 * Only these connections can ever serve a `sign_in` request: they are the
 * ones whose credential belongs to the person asking. App-scoped
 * connections (Intercom, Inngest, Linear, Lucent, PlanetScale) hold agent
 * credentials and never run a consent flow, so they are deliberately absent.
 * The name set is pinned by the sign-in tests against the connection files
 * that import `user-connect`, so a new user-scoped connection fails the
 * suite until it is registered here.
 */
const CONNECTIONS: Readonly<Record<string, { auth?: unknown }>> = {
  autumn,
  axiom,
  exa,
  jam,
  modem,
  neon,
  openrouter,
  posthog,
  resend,
  sentry,
  stripe,
  supermemory,
  vercel,
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
