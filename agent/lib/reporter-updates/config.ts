import type { RunConfig } from "./run.js";

type Env = Record<string, string | undefined>;

const CHANNEL = /^C[A-Z0-9]{8,12}$/u;
const HOUR_MS = 3_600_000;
const DEFAULT_LOOKBACK_HOURS = 12;
const MAX_LOOKBACK_HOURS = 72;
const DEFAULT_MAX_POSTS = 20;
const MAX_MAX_POSTS = 100;

const boundedInteger = (
  raw: string | undefined,
  fallback: number,
  max: number
): number => {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1
    ? Math.min(value, max)
    : fallback;
};

export const reporterUpdatesConfig = (
  env: Env = process.env
): RunConfig | null => {
  if (env.REPORTER_UPDATES_ENABLED !== "true") {
    return null;
  }
  const channels = (env.REPORTER_UPDATES_CHANNELS ?? "")
    .split(",")
    .map((channel) => channel.trim())
    .filter((channel) => CHANNEL.test(channel));
  const since = Date.parse(env.REPORTER_UPDATES_SINCE ?? "");
  if (channels.length === 0 || Number.isNaN(since)) {
    return null;
  }
  return {
    channels: new Set(channels),
    lookbackMs:
      boundedInteger(
        env.REPORTER_UPDATES_LOOKBACK_HOURS,
        DEFAULT_LOOKBACK_HOURS,
        MAX_LOOKBACK_HOURS
      ) * HOUR_MS,
    maxPosts: boundedInteger(
      env.REPORTER_UPDATES_MAX_POSTS,
      DEFAULT_MAX_POSTS,
      MAX_MAX_POSTS
    ),
    nameOwner: env.REPORTER_UPDATES_NAME_OWNER === "true",
    since: new Date(since).toISOString(),
  };
};
