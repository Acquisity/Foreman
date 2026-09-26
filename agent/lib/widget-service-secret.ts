import { createHash, timingSafeEqual } from "node:crypto";

/** The server-only credential the Acquisity app adds to every widget request. */
export const SERVICE_SECRET_HEADER = "x-acquisity-service-secret";

const digest = (value: string) => createHash("sha256").update(value).digest();

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
  if (process.env.SUPPORT_CHAT_ENABLED !== "true") {
    return Response.json(
      { error: "Not found." },
      { headers: { "cache-control": "no-store" }, status: 404 }
    );
  }
  const expected = process.env.FOREMAN_DIAGNOSTICS_SECRET;
  if (!expected || expected.length < 32) {
    return Response.json(
      { error: "Support chat is not configured." },
      { headers: { "cache-control": "no-store" }, status: 503 }
    );
  }
  const given = request.headers.get(SERVICE_SECRET_HEADER) ?? "";
  return timingSafeEqual(digest(given), digest(expected))
    ? null
    : Response.json(
        { error: "Workspace could not be verified." },
        { headers: { "cache-control": "no-store" }, status: 403 }
      );
}
