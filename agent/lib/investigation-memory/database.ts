import { type NeonQueryFunction, neon } from "@neondatabase/serverless";

/** The private investigation store is unavailable. This never changes a verdict. */
export class MemoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryUnavailableError";
  }
}

let client: NeonQueryFunction<false, false> | null = null;

export const memoryDatabase = (): NeonQueryFunction<false, false> => {
  if (client !== null) {
    return client;
  }
  const url = process.env.FOREMAN_MEMORY_DATABASE_URL;
  if (!url) {
    throw new MemoryUnavailableError(
      "FOREMAN_MEMORY_DATABASE_URL is not set, so investigation memory is unavailable."
    );
  }
  client = neon(url);
  return client;
};

export const isMemoryDatabaseConfigured = (): boolean =>
  typeof process.env.FOREMAN_MEMORY_DATABASE_URL === "string" &&
  process.env.FOREMAN_MEMORY_DATABASE_URL !== "";
