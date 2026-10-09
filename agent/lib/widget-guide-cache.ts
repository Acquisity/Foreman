import { createHash } from "node:crypto";
import { z } from "zod";

const GENERATED_FROM = /from Acquisity ([0-9a-f]{12})\./u;
const CACHE_KEY = /^[0-9a-f]{64}$/u;
const CACHE = z.record(z.string().regex(CACHE_KEY), z.string());

export const parseGuideCache = (source: string): Record<string, string> =>
  CACHE.parse(JSON.parse(source));

export const guideArtifactsEqual = (
  before: { guide: string; cache: string },
  after: { guide: string; cache: string }
): boolean => {
  const oldCache = parseGuideCache(before.cache);
  const newCache = parseGuideCache(after.cache);
  const oldSha = before.guide.match(GENERATED_FROM)?.[1];
  const newSha = after.guide.match(GENERATED_FROM)?.[1];
  const sameGuide =
    oldSha && newSha
      ? before.guide.replaceAll(oldSha, newSha) === after.guide
      : before.guide === after.guide;
  return (
    sameGuide &&
    Object.keys(oldCache).length === Object.keys(newCache).length &&
    Object.entries(oldCache).every(([key, text]) => newCache[key] === text)
  );
};

export const guideCallKey = (...inputs: string[]): string =>
  createHash("sha256").update(JSON.stringify(inputs)).digest("hex");

export const cachedGuideText = (
  cache: Readonly<Record<string, string>>,
  key: string,
  full: boolean
): string | undefined =>
  full || !Object.hasOwn(cache, key) ? undefined : cache[key];

export interface GuideCallStats {
  attempts: number;
  successfulCalls: number;
}

export const countedGuideAttempt = async <T>(
  stats: GuideCallStats,
  generate: () => Promise<T>
): Promise<T> => {
  stats.attempts += 1;
  const result = await generate();
  stats.successfulCalls += 1;
  return result;
};

export const assertGuideCallStopped = (finishReason: string): void => {
  if (finishReason !== "stop") {
    throw new Error(`distill call ended with ${finishReason}`);
  }
};

export async function checkedGuideCall<
  T extends { fresh: boolean; text: string },
>(
  label: string,
  tries: number,
  distill: () => Promise<T>,
  check: (text: string) => string
): Promise<T> {
  for (let left = tries; ; left -= 1) {
    let out: T | undefined;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: each try depends on the last.
      out = await distill();
      return { ...out, text: check(out.text) };
    } catch (error) {
      if (out?.fresh === false || left <= 1) {
        throw new Error(`${label}: ${String(error)}`, { cause: error });
      }
      console.log(`  retry ${label} after ${String(error).slice(0, 160)}`);
    }
  }
}
