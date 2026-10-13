import { neon } from "@neondatabase/serverless";

/** Shared private-DB transport; stores retain their own schemas and authorization. */
export function privateDatabase(timeoutMs = 15_000, signal?: AbortSignal) {
  const url = process.env.FOREMAN_MEMORY_DATABASE_URL;
  if (!url) {
    throw new Error("Foreman's private database is not configured.");
  }
  return neon(url, {
    fetchOptions: {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    },
  });
}
