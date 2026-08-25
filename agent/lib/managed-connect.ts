import {
  connect,
  type EveAuthorizationOptions,
  type EveConnectAuthorizationDefinition,
} from "@vercel/connect/eve";
import type {
  InteractiveAuthorizationDefinition,
  NonInteractiveAuthorizationDefinition,
} from "eve/connections";

/**
 * Resolves a token from a connector that is attached to Foreman's Vercel
 * project outside the runtime. The Connect SDK otherwise attempts a managed
 * connector provision before each cold token lookup, which this project does
 * not authorize through deployment OIDC.
 */
export function managedConnect(
  options: EveAuthorizationOptions & { readonly principalType: "app" }
): EveConnectAuthorizationDefinition<NonInteractiveAuthorizationDefinition>;
export function managedConnect(
  options: EveAuthorizationOptions & { readonly principalType?: "user" }
): EveConnectAuthorizationDefinition<InteractiveAuthorizationDefinition>;
export function managedConnect(options: EveAuthorizationOptions) {
  return connect({ ...options, autoProvision: false });
}
