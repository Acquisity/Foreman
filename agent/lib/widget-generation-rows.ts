/** Axiom dataset names the bug report's reads accept. */
export const DATASET_NAME = /^[A-Za-z0-9._-]{1,120}$/;

const CANDIDATE_LIMIT = 200;
const ROW_KEYS = ["issues", "events", "data", "results", "rows", "matches"];

/** The row array from a recognized envelope, or null when the shape is not one we know. */
export function collectRows(parsed: unknown): unknown[] | null {
  const flatten = (rows: unknown[]): unknown[] =>
    rows
      .slice(0, CANDIDATE_LIMIT)
      .map((row) =>
        row &&
        typeof row === "object" &&
        "data" in row &&
        (row as { data?: unknown }).data &&
        typeof (row as { data: unknown }).data === "object"
          ? { ...(row as object), ...(row as { data: object }).data }
          : row
      );
  if (Array.isArray(parsed)) {
    return flatten(parsed);
  }
  if (parsed && typeof parsed === "object") {
    for (const key of ROW_KEYS) {
      const value = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        return flatten(value);
      }
    }
  }
  return null;
}
