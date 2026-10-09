import { createHash } from "node:crypto";

/** A guide model call's cache key: a hash of every input that shapes its output. */
export const guideCallKey = (...inputs: string[]): string =>
  createHash("sha256").update(JSON.stringify(inputs)).digest("hex");

/**
 * The earlier output a call can reuse, or undefined when it must call the
 * model: its key is not in the cache, or `full` asks for a fresh run.
 */
export const cachedGuideText = (
  cache: Readonly<Record<string, string>>,
  key: string,
  full: boolean
): string | undefined =>
  full || !Object.hasOwn(cache, key) ? undefined : cache[key];
