import { isConnectionAuthorizationFailedError } from "eve/connections";
import { ExecutorError } from "./executor/transport.js";
import { truncateRows } from "./planetscale.js";

const PG_OFFSET = /([+-]\d\d)$/u;
const ERROR_CHARS = 300;
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Rows kept and whether a row limit or byte cap cut the list. */
export interface RowList<T = Record<string, unknown>> {
  rows: T[];
  truncated: boolean;
}

export type Source<T> =
  | { checked: true; facts: T }
  | { checked: false; error: string; facts?: T };

/** One fact a verdict flag rests on, with where and when it came from. */
export interface Fact {
  date: string | null;
  detail: string;
  source: string;
}

/** True, false, or null when the facts that decide it could not be read. */
export interface Flag {
  because: Fact[];
  proofTruncated?: boolean;
  unknown?: string;
  value: boolean | null;
}

export type Obj = Record<string, unknown>;
export const obj = (value: unknown): Obj =>
  value !== null && typeof value === "object" ? (value as Obj) : {};
export const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
export const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
/** Milliseconds for an ISO or Postgres timestamp, or null. */
export const ms = (value: unknown): number | null => {
  const text = str(value);
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text.replace(" ", "T").replace(PG_OFFSET, "$1:00"));
  return Number.isNaN(parsed) ? null : parsed;
};
export const clip = (value: unknown, chars: number): string | null => {
  const text = typeof value === "string" ? value : null;
  return text && text.length > chars ? `${text.slice(0, chars)}...` : text;
};
/** Bound strings at the output boundary, including provider-owned nested values. */
export const boundedText = <T>(value: T): { value: T; clipped: boolean } => {
  let clipped = false;
  const json = JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "string" && entry.length > 4000) {
      clipped = true;
      return `${entry.slice(0, 4000)}...`;
    }
    return entry;
  });
  return { clipped, value: JSON.parse(json) as T };
};

export const rowList = <T>(
  rows: T[],
  limit: number,
  cut = false
): RowList<T> => {
  const bounded = boundedText(rows.slice(0, limit));
  const kept = truncateRows(bounded.value, 32 * 1024);
  return {
    rows: kept.rows as T[],
    truncated: cut || rows.length > limit || bounded.clipped || kept.truncated,
  };
};

export const failure = (error: unknown): string => {
  let cause = error;
  for (let depth = 0; depth < 8 && cause instanceof Error; depth += 1) {
    if (isConnectionAuthorizationFailedError(cause)) {
      return `Executor authorization is unavailable (${cause.reason ?? "authorization_failed"}).`.slice(
        0,
        ERROR_CHARS
      );
    }
    if (cause instanceof ExecutorError) {
      return `Executor could not complete the call (${cause.code}).`.slice(
        0,
        ERROR_CHARS
      );
    }
    ({ cause } = cause);
  }
  return (
    error instanceof Error ? error.message : "The read could not run."
  ).slice(0, ERROR_CHARS);
};

const unavailable = (facts: unknown): string[] => {
  const value = obj(facts).unavailable;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};

export const attempt = async <T>(
  read: () => Promise<T>
): Promise<Source<T>> => {
  try {
    const facts = await read();
    return unavailable(facts).length
      ? {
          checked: false,
          error: unavailable(facts).join("; ").slice(0, ERROR_CHARS),
          facts,
        }
      : { checked: true, facts };
  } catch (error) {
    return { checked: false, error: failure(error) };
  }
};
