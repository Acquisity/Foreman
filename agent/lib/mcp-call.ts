/**
 * One MCP `tools/call` over the Streamable HTTP transport, hand-rolled so a
 * fixed authored tool can call a single remote tool with a bearer token and
 * bound the result before it reaches the model.
 *
 * The full handshake runs per call: `initialize`, echo the `mcp-session-id`
 * header when present, `notifications/initialized`, then `tools/call`. The
 * token is sent only as `Authorization: Bearer <token>` and never appears in
 * the returned value or in errors.
 */

const JSON_RPC_VERSION = "2.0";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 50_000;
const DETAIL_CHARS = 500;

/** An HTTP-level failure from an MCP endpoint, carrying the status so the caller can map 401/403 to a re-authorization challenge. */
export class McpHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "McpHttpError";
    this.status = status;
  }
}

export interface CallMcpToolOptions {
  /** Tool arguments. */
  args: Record<string, unknown>;
  /** Injectable `fetch` for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Prefix for error messages, such as `PlanetScale MCP`. */
  label: string;
  /** Caller cancellation, joined with the per-request timeout. */
  signal?: AbortSignal;
  /** Per-request timeout; defaults to 50 s. */
  timeoutMs?: number;
  /** Bearer token; never echoed. */
  token: string;
  /** Remote tool name. */
  tool: string;
  /** The MCP endpoint. */
  url: string;
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

/** Parses a JSON-RPC body, preferring plain JSON and falling back to SSE `data:` lines. */
function extractMessage(body: string, label: string): JsonRpcMessage {
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
  throw new Error(`${label} response contained no JSON-RPC result.`);
}

/** Joins the text parts of an MCP `content` array into one string. */
const joinContentText = (
  content: Array<{ type?: string; text?: string }> | undefined
): string =>
  (content ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((text): text is string => typeof text === "string")
    .join("");

/**
 * Calls one tool on an MCP server and returns the concatenated text of its
 * `result.content`. HTTP failures throw {@link McpHttpError}; a JSON-RPC error
 * or an `isError` result throws a plain `Error` carrying the server's text.
 */
export async function callMcpTool(
  options: CallMcpToolOptions
): Promise<string> {
  const { args, label, tool, url } = options;
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = () => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
  };

  const baseHeaders: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
  };

  const post = async (
    headers: Record<string, string>,
    body: Record<string, unknown>,
    step: string
  ): Promise<Response> => {
    const response = await fetchImpl(url, {
      body: JSON.stringify({ jsonrpc: JSON_RPC_VERSION, ...body }),
      headers,
      method: "POST",
      signal: signal(),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, DETAIL_CHARS);
      throw new McpHttpError(
        response.status,
        `${label} ${step} failed: HTTP ${response.status}. ${detail}`
      );
    }
    return response;
  };

  const initializeResponse = await post(
    baseHeaders,
    {
      id: 1,
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "foreman-agent", version: "0.0.0" },
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
    },
    "initialize"
  );
  const sessionId = initializeResponse.headers.get("mcp-session-id");
  const initializeMessage = extractMessage(
    await initializeResponse.text(),
    label
  );
  if (initializeMessage.error !== undefined) {
    throw new Error(
      `${label} initialize error: ${JSON.stringify(initializeMessage.error)}.`
    );
  }

  const sessionHeaders = {
    ...baseHeaders,
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };

  // Consume the body so the socket is released.
  await (
    await post(
      sessionHeaders,
      { method: "notifications/initialized" },
      "notifications/initialized"
    )
  ).text();

  const callResponse = await post(
    sessionHeaders,
    { id: 2, method: "tools/call", params: { arguments: args, name: tool } },
    "tools/call"
  );
  const callMessage = extractMessage(await callResponse.text(), label);
  if (callMessage.error !== undefined) {
    throw new Error(
      `${label} tools/call error: ${JSON.stringify(callMessage.error)}.`
    );
  }

  const { result } = callMessage;
  if (result?.isError === true) {
    throw new Error(
      `${label} ${tool} failed: ${joinContentText(result.content) || "unknown error"}.`
    );
  }
  return joinContentText(result?.content);
}
