/**
 * PlanetScale read-query access, hand-rolled over the MCP Streamable HTTP
 * transport.
 *
 * The PlanetScale MCP connection is read-only, but its `execute_read_query`
 * tool returns the full rows array with no size limit. A single wide query
 * can exceed the workflow stream's 10 MB per-chunk limit and kill the session,
 * so this module calls the tool directly and truncates the rows before they
 * are handed back to the model.
 */

/** The PlanetScale MCP endpoint (Streamable HTTP transport). */
const PLANETSCALE_MCP_URL = "https://mcp.pscale.dev/mcp/planetscale";

/** JSON-RPC protocol version. */
const JSON_RPC_VERSION = "2.0";

/** MCP protocol version negotiated during `initialize`. */
const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Tool name on the PlanetScale MCP server for a read query. */
const READ_QUERY_TOOL = "planetscale_execute_read_query";

/**
 * Per-request timeout, matching the PlanetScale MCP server's own 50s query
 * deadline so a hung upstream cannot hold the workflow step indefinitely.
 */
const REQUEST_TIMEOUT_MS = 50_000;

/** Options for {@link callPlanetscaleReadQuery}. */
export interface CallPlanetscaleReadQueryOptions {
  /** Injectable `fetch` for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * An HTTP-level failure from the PlanetScale MCP endpoint, carrying the status
 * so the caller can map 401/403 to a re-authorization challenge.
 */
export class PlanetscaleHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PlanetscaleHttpError";
    this.status = status;
  }
}

/** A single JSON-RPC response message, narrowed to the fields we read. */
interface JsonRpcMessage {
  error?: unknown;
  id?: number | string | null;
  jsonrpc?: string;
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
    [key: string]: unknown;
  };
}

/**
 * Parses a JSON-RPC response body, preferring a plain JSON body and falling
 * back to Server-Sent Events (`data:`-line) extraction.
 *
 * @param body - The raw response body text.
 * @returns The first message carrying a `result` or `error`.
 */
function extractMessage(body: string): JsonRpcMessage {
  try {
    return JSON.parse(body) as JsonRpcMessage;
  } catch {
    // Fall through to SSE extraction.
  }

  const messages: JsonRpcMessage[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const payload = trimmed.slice("data:".length).trim();
    if (!payload) {
      continue;
    }
    try {
      messages.push(JSON.parse(payload) as JsonRpcMessage);
    } catch {
      // Ignore malformed SSE lines.
    }
  }

  const withResult = messages.find((message) => message.result !== undefined);
  const withError = messages.find((message) => message.error !== undefined);
  if (withResult) {
    return withResult;
  }
  if (withError) {
    return withError;
  }
  throw new Error("PlanetScale MCP response contained no JSON-RPC result.");
}

/** Joins the text parts of an MCP `content` array into one string. */
function joinContentText(
  content: Array<{ type?: string; text?: string }> | undefined
): string {
  return (content ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((text): text is string => typeof text === "string")
    .join("");
}

/**
 * Calls `planetscale_execute_read_query` on the PlanetScale MCP server over
 * Streamable HTTP and returns the concatenated text of its `result.content`.
 *
 * The full handshake is performed per call: `initialize`, echo the
 * `mcp-session-id` header when present, `notifications/initialized`, then
 * `tools/call`. The token is sent only as `Authorization: Bearer <token>` and
 * never appears in the returned value. HTTP failures throw
 * {@link PlanetscaleHttpError} so the caller can re-challenge on 401/403.
 *
 * @param token - The PlanetScale service-token SECRET.
 * @param args - The tool arguments (e.g. `{ query, database, branch }`).
 * @param opts - Optional overrides, primarily `fetch` for tests.
 * @returns The concatenated text of the tool's `result.content`.
 */
export async function callPlanetscaleReadQuery(
  token: string,
  args: Record<string, unknown>,
  opts?: CallPlanetscaleReadQueryOptions
): Promise<string> {
  const fetchImpl = opts?.fetch ?? fetch;

  const baseHeaders: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const initializeResponse = await fetchImpl(PLANETSCALE_MCP_URL, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: JSON_RPC_VERSION,
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "foreman-agent", version: "0.0.0" },
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
    }),
    headers: baseHeaders,
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!initializeResponse.ok) {
    throw new PlanetscaleHttpError(
      initializeResponse.status,
      `PlanetScale MCP initialize failed: HTTP ${initializeResponse.status}.`
    );
  }
  const sessionId = initializeResponse.headers.get("mcp-session-id");
  const initializeMessage = extractMessage(await initializeResponse.text());
  if (initializeMessage.error !== undefined) {
    throw new Error(
      `PlanetScale MCP initialize error: ${JSON.stringify(initializeMessage.error)}.`
    );
  }

  const sessionHeaders = {
    ...baseHeaders,
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };

  const notificationResponse = await fetchImpl(PLANETSCALE_MCP_URL, {
    body: JSON.stringify({
      jsonrpc: JSON_RPC_VERSION,
      method: "notifications/initialized",
    }),
    headers: sessionHeaders,
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!notificationResponse.ok) {
    throw new PlanetscaleHttpError(
      notificationResponse.status,
      `PlanetScale MCP notifications/initialized failed: HTTP ${notificationResponse.status}.`
    );
  }
  // Consume the body so the socket is released.
  await notificationResponse.text();

  const callResponse = await fetchImpl(PLANETSCALE_MCP_URL, {
    body: JSON.stringify({
      id: 2,
      jsonrpc: JSON_RPC_VERSION,
      method: "tools/call",
      params: { arguments: args, name: READ_QUERY_TOOL },
    }),
    headers: sessionHeaders,
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!callResponse.ok) {
    throw new PlanetscaleHttpError(
      callResponse.status,
      `PlanetScale MCP tools/call failed: HTTP ${callResponse.status}.`
    );
  }
  const callMessage = extractMessage(await callResponse.text());
  if (callMessage.error !== undefined) {
    throw new Error(
      `PlanetScale MCP tools/call error: ${JSON.stringify(callMessage.error)}.`
    );
  }

  const { result } = callMessage;
  if (result?.isError === true) {
    const errorText = joinContentText(result.content);
    throw new Error(
      `PlanetScale read query failed: ${errorText || "unknown error"}.`
    );
  }

  return joinContentText(result?.content);
}

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
  const overheadBytes = Buffer.byteLength(
    JSON.stringify({
      ...passthrough,
      envelopeTooLarge: false,
      oversizedRow: true,
      resultBytes: capBytes,
      returnedRows: rows.length,
      success: true,
      totalRows: rows.length,
      truncated: true,
    }),
    "utf8"
  );
  const truncated = truncateRows(rows, capBytes, overheadBytes);
  return {
    ...passthrough,
    envelopeTooLarge: truncated.envelopeTooLarge,
    oversizedRow: truncated.oversizedRow,
    resultBytes: truncated.resultBytes,
    returnedRows: truncated.returnedRows,
    rows: truncated.rows,
    success: true,
    totalRows: truncated.totalRows,
    truncated: truncated.truncated,
  };
}
