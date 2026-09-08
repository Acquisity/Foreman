import type { ToolContext } from "eve/tools";
import { executorReadQuery } from "./executor/client.js";

/** The bounded query helper retains its result contract; only Executor performs provider calls. */
export const callPlanetscaleReadQuery = (
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> => executorReadQuery(ctx, args);

/** Result of {@link truncateRows}. */
export interface TruncateRowsResult {
  /** Whether the overhead (passthrough plus metadata) alone exceeded the cap. */
  envelopeTooLarge: boolean;
  /** Whether a single row alone exceeded the cap, so nothing was kept. */
  oversizedRow: boolean;
  /** Serialized byte length of the kept rows array (`Buffer.byteLength(JSON.stringify(kept))`). */
  resultBytes: number;
  /** The number of rows kept. */
  returnedRows: number;
  /** The rows kept, in original order, until the byte cap would be exceeded. */
  rows: unknown[];
  /** The total number of rows in the input. */
  totalRows: number;
  /** Whether any rows were dropped because the cap was reached. */
  truncated: boolean;
}

/**
 * Deterministically truncates `rows` so the serialized rows array stays within
 * `capBytes` minus `overheadBytes`. Each row is `JSON.stringify`'d exactly once;
 * rows are kept in order until adding the next would exceed the budget.
 *
 * The budget accounts for the array brackets and the comma between each pair
 * of kept rows, so `resultBytes` equals the UTF-8 byte length of
 * `JSON.stringify(kept)`. Pass `overheadBytes` as the measured size of
 * everything else in the returned object (metadata keys plus passthrough
 * fields) so the full serialized output stays under the cap.
 *
 * @param rows - The rows to truncate.
 * @param capBytes - The maximum serialized byte size of the full result.
 * @param overheadBytes - Serialized size of everything except the rows array.
 * @returns The kept rows plus truncation metadata.
 */
export function truncateRows(
  rows: unknown[],
  capBytes: number,
  overheadBytes = 0
): TruncateRowsResult {
  const kept: unknown[] = [];
  const envelopeTooLarge = overheadBytes >= capBytes;
  const rowsBudget = Math.max(0, capBytes - overheadBytes);
  // "[" and "]" bracket the array; each row after the first adds a comma.
  let resultBytes = 2;
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
    const commaBytes = kept.length > 0 ? 1 : 0;
    if (resultBytes + rowBytes + commaBytes > rowsBudget) {
      break;
    }
    kept.push(row);
    resultBytes += rowBytes + commaBytes;
  }
  return {
    envelopeTooLarge,
    oversizedRow: !envelopeTooLarge && kept.length === 0 && rows.length > 0,
    resultBytes,
    returnedRows: kept.length,
    rows: kept,
    totalRows: rows.length,
    truncated: kept.length < rows.length,
  };
}

/** Result of {@link parseReadQueryResult}. */
export interface ParseReadQueryResult {
  /** Any other top-level fields, preserved verbatim. */
  passthrough: Record<string, unknown>;
  /** The rows array extracted from the query result. */
  rows: unknown[];
}

/**
 * Parses the text returned by `planetscale_execute_read_query` into a rows
 * array plus any other top-level fields. Accepts either a bare JSON array or
 * an object with a `rows` array; other object fields are preserved verbatim.
 *
 * @param text - The raw text of the tool's `result.content`.
 * @returns The rows and passthrough fields.
 */
export function parseReadQueryResult(text: string): ParseReadQueryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const prefix = text.slice(0, 200);
    throw new Error(
      `PlanetScale read query returned non-JSON content: ${prefix}${text.length > 200 ? "..." : ""}`,
      { cause: error }
    );
  }

  if (Array.isArray(parsed)) {
    return { passthrough: {}, rows: parsed };
  }

  if (parsed !== null && typeof parsed === "object") {
    const object = parsed as Record<string, unknown>;
    if (Array.isArray(object.rows)) {
      const { rows, ...passthrough } = object;
      return { passthrough, rows };
    }
  }

  throw new Error(
    "PlanetScale read query returned an unrecognized result shape."
  );
}

/**
 * Builds the final tool result for a read query: measures the overhead of
 * everything that will surround the rows array, truncates the rows to fit the
 * remaining budget, and returns the assembled object. Exported so the
 * end-to-end size invariant can be tested directly.
 *
 * @param rows - The parsed rows.
 * @param passthrough - Other top-level fields from the server result.
 * @param capBytes - The maximum serialized byte size of the full result.
 * @returns The assembled result object.
 */
export function buildReadQueryResult(
  rows: unknown[],
  passthrough: Record<string, unknown>,
  capBytes: number
): Record<string, unknown> {
  // Reserve the rows member and worst-case flag widths; truncateRows counts the array brackets.
  const overheadBytes =
    Buffer.byteLength(
      JSON.stringify({
        ...passthrough,
        envelopeTooLarge: false,
        oversizedRow: false,
        resultBytes: capBytes,
        returnedRows: rows.length,
        rows: [],
        success: true,
        totalRows: rows.length,
        truncated: false,
      }),
      "utf8"
    ) - 2;
  const truncated = truncateRows(rows, capBytes, overheadBytes);
  if (truncated.envelopeTooLarge) {
    // The passthrough fields alone consumed the budget; drop them so the
    // returned object stays under the cap instead of echoing a huge envelope.
    return {
      envelopeTooLarge: true,
      oversizedRow: false,
      resultBytes: 0,
      returnedRows: 0,
      rows: [],
      success: true,
      totalRows: rows.length,
      truncated: true,
    };
  }
  return {
    ...passthrough,
    envelopeTooLarge: false,
    oversizedRow: truncated.oversizedRow,
    resultBytes: truncated.resultBytes,
    returnedRows: truncated.returnedRows,
    rows: truncated.rows,
    success: true,
    totalRows: truncated.totalRows,
    truncated: truncated.truncated,
  };
}
