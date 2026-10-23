import type { RunConfig } from "./run.js";

type Env = Record<string, string | undefined>;

const CHANNEL = /^C[A-Z0-9]{8,12}$/u;
const DEFAULT_MAX_POSTS = 20;
export const RUN_DEADLINE_MS = 240_000;
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
    maxPosts: boundedInteger(
      env.REPORTER_UPDATES_MAX_POSTS,
      DEFAULT_MAX_POSTS,
      MAX_MAX_POSTS
    ),
    nameOwner: env.REPORTER_UPDATES_NAME_OWNER === "true",
    runDeadlineMs: RUN_DEADLINE_MS,
    since: new Date(since).toISOString(),
  };
};
