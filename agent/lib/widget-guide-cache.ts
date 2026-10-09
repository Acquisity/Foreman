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

/**
 * Calls `distill` until `check` accepts its output (returning the repaired
 * text, or throwing), at most `tries` times. Only the failing batch is called
 * again, so other batches' paid output survives; a reused output that fails is
 * not retried, since a retry would return it unchanged.
 */
export async function checkedGuideCall<
  T extends { fresh: boolean; text: string },
>(
  label: string,
  tries: number,
  distill: () => Promise<T>,
  check: (text: string) => string
): Promise<T> {
  for (let left = tries; ; left -= 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each try depends on the last.
    const out = await distill();
    try {
      return { ...out, text: check(out.text) };
    } catch (error) {
      if (!out.fresh || left <= 1) {
        throw new Error(`${label}: ${String(error)}`, { cause: error });
      }
      console.log(`  retry ${label} after ${String(error).slice(0, 160)}`);
    }
  }
}
