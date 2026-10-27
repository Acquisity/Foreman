import { diagnosticsSecretRefusal } from "./diagnostics-secret.js";

/** The server-only credential the Acquisity app adds to every widget request. */
export const SERVICE_SECRET_HEADER = "x-acquisity-service-secret";

/**
 * The customer's identity token is also handed to their browser, so on its own
 * it would let a customer call these routes directly and read findings the
 * gate held back. Every widget request must also carry the shared
 * FOREMAN_DIAGNOSTICS_SECRET, which only the Acquisity server holds. Runs
 * first on every widget route, after the feature switch: returns the refusal
 * to send, or null when the request may proceed. Digests keep the
 * comparison constant-time whatever the lengths.
 */
export function serviceSecretRefusal(request: Request): Response | null {
  return diagnosticsSecretRefusal(request, {
    enabled: process.env.SUPPORT_CHAT_ENABLED === "true",
    forbidden: "Workspace could not be verified.",
    header: SERVICE_SECRET_HEADER,
    notConfigured: "Support chat is not configured.",
  });
}
