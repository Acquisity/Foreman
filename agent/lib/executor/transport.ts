import { z } from "zod";
import { type ExecutorToolkit, toolkitUrl } from "./endpoint.js";

const envelopeSchema = z.object({
  error: z.unknown().optional(),
  id: z.union([z.number(), z.string()]),
  result: z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z
        .object({
          execution: z
            .object({ ok: z.boolean(), value: z.unknown().optional() })
            .passthrough()
            .optional(),
          status: z.string(),
        })
        .optional(),
    })
    .passthrough()
    .optional(),
});
const outcomeSchema = z.discriminatedUnion("ok", [
  z.object({
    data: z.unknown(),
    http: z
      .object({
        headers: z.record(z.string(), z.string()).optional(),
        status: z.number(),
      })
      .optional(),
    ok: z.literal(true),
  }),
  z.object({
    error: z.object({
      code: z.string().max(100),
      retryAfter: z.string().max(200).optional(),
      retryable: z.boolean().optional(),
      status: z.number().optional(),
    }),
    ok: z.literal(false),
  }),
]);

export interface ExecutorRequestContext {
  signal: AbortSignal;
  token: string;
  toolkit?: ExecutorToolkit;
}
export class ExecutorError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly retryAfter: string | undefined;
  readonly dispatched: false | undefined;
  constructor(
    code: string,
    status?: number,
    options?: ErrorOptions & { retryAfter?: string; dispatched?: false }
  ) {
    super(
      `Executor operation failed (${code}${status === undefined ? "" : `, HTTP ${status}`}).`,
      options
    );
    this.name = "ExecutorError";
    this.code = code;
    this.status = status;
    this.retryAfter = options?.retryAfter;
    this.dispatched = options?.dispatched;
  }
}
const SSE_BLOCK = /\r?\n\r?\n/u;
const SSE_LINE = /\r?\n/u;
/** Executor v2 path: an app slug (a DNS label), then the tool's path inside the app. */
export const OPERATION_PATH =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[A-Za-z0-9_-]+)+$/u;

// beta.39: apps/src/implementation/failure-detail.ts:323-341 and sdk/src/contracts/tools.ts:1360-1446.
const OPENAPI_FAILURE =
  /^The app's API call failed: (?:The API request|(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/[^\s]{1,500}) responded with HTTP ([345]\d{2})(?: \([^()\r\n]{1,200}\))?, which matches no error with a message in the API's OpenAPI document\.$/u;
const PROVIDER_FAILURE =
  /^[^\r\n]{1,100} (?:returned a server error|rejected the credentials|reported insufficient permission|is limiting requests|refused the request)(?: for account “[^”\r\n]{1,200}”)? \(HTTP ([345]\d{2})\)(?: while (?:connecting|calling a tool|listing its tools))?\.(?: The service reported [A-Za-z0-9_.-]{1,100}(?:: "(?:[^"\\\r\n]|\\[^\r\n]){0,2000}")?\.| We could not identify the cause from the available error details\.)?$/u;

/** Body parsing stays under the caller's deadline, including stalled streams. */
async function readBody(
  response: Response,
  signal: AbortSignal,
  maxBytes: number
): Promise<string> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    response.body?.cancel().catch(() => undefined);
    throw new ExecutorError("response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the stream ends on done.
    while (true) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential chunks enforce the response cap.
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        throw new ExecutorError("response_too_large");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", abort);
    reader.cancel().catch(() => undefined);
  }
}

function rpcMessage(body: string, id: number) {
  const candidates: unknown[] = [];
  try {
    candidates.push(JSON.parse(body));
  } catch {
    for (const block of body.split(SSE_BLOCK)) {
      const data = block
        .split(SSE_LINE)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          candidates.push(JSON.parse(data));
        } catch {
          /* Ignore non-result events. */
        }
      }
    }
  }
  for (const value of candidates) {
    const parsed = envelopeSchema.safeParse(value);
    if (parsed.success && parsed.data.id === id) {
      return parsed.data;
    }
  }
  throw new ExecutorError("invalid_rpc_response");
}

/** Fresh MCP session per helper call. No session cache or approval resume. */
async function invokeExecutor(
  ctx: ExecutorRequestContext,
  path: string,
  input: Record<string, unknown>,
  options: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {}
) {
  if (!OPERATION_PATH.test(path) || path.startsWith("executor.")) {
    throw new ExecutorError("invalid_operation_binding");
  }
  const dot = path.indexOf(".");
  const tool = `tools[${JSON.stringify(path.slice(0, dot))}][${JSON.stringify(path.slice(dot + 1))}]`;
  // shortcut: parses beta.39 message text for upstream status, replace when v2 exposes a machine field.
  // Only machine fields leave the program; provider text and recovery stay inside Executor.
  const result = await executeExecutor(
    ctx,
    `const input = ${JSON.stringify(input)};
try { return { ok: true, data: (await ${tool}(input)) ?? null }; }
catch (error) {
  let diagnostic;
  try { diagnostic = JSON.parse(error.message); } catch {}
  if (!diagnostic || typeof diagnostic !== "object") return { ok: false, error: { code: "tool_error" } };
  const code = typeof diagnostic.code === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(diagnostic.code) ? diagnostic.code : "tool_error";
  let status = Number.isInteger(diagnostic.status) && diagnostic.status >= 300 && diagnostic.status <= 599 ? diagnostic.status : undefined;
  const message = typeof diagnostic.message === "string" && diagnostic.message.length <= 4096 ? diagnostic.message : "";
  const openapi = code === "ToolCallFailed" && status === 502 ? ${OPENAPI_FAILURE}.exec(message) : null;
  const provider = code === "AppProviderFailed" && status === 502 ? ${PROVIDER_FAILURE}.exec(message) : null;
  if (openapi || provider) status = Number((openapi || provider)[1]);
  return { ok: false, error: { code, ...(status === undefined ? {} : { status }), ...(typeof diagnostic.retryable === "boolean" ? { retryable: diagnostic.retryable } : {}) } };
}`,
    options
  );
  const parsed = outcomeSchema.safeParse(result);
  if (!parsed.success) {
    throw new ExecutorError("invalid_operation_result");
  }
  return parsed.data;
}

/** Application-authored source only. Never expose source as a tool input. */
async function executeExecutor(
  ctx: ExecutorRequestContext,
  code: string,
  options: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {}
): Promise<unknown> {
  let dispatched = false;
  try {
    return await executeExecutorRequest(ctx, code, options, () => {
      dispatched = true;
    });
  } catch (cause) {
    if (dispatched) {
      throw cause;
    }
    // biome-ignore lint/style/useErrorCause: ExecutorError receives the original cause in its third argument.
    throw new ExecutorError(
      cause instanceof ExecutorError ? cause.code : "execution_not_dispatched",
      cause instanceof ExecutorError ? cause.status : undefined,
      {
        cause,
        dispatched: false,
        retryAfter:
          cause instanceof ExecutorError ? cause.retryAfter : undefined,
      }
    );
  }
}

async function executeExecutorRequest(
  ctx: ExecutorRequestContext,
  code: string,
  options: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number },
  markDispatched: () => void
): Promise<unknown> {
  const signal = AbortSignal.any([
    ctx.signal,
    AbortSignal.timeout(options.timeoutMs ?? 50_000),
  ]);
  signal.throwIfAborted();
  const endpoint = toolkitUrl(ctx.toolkit);
  const fetchImpl = options.fetch ?? fetch;
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${ctx.token}`,
    "Content-Type": "application/json",
  };
  const post = async (body: Record<string, unknown>, id?: number) => {
    const response = await fetchImpl(endpoint, {
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      headers,
      method: "POST",
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      response.body?.cancel().catch(() => undefined);
      throw new ExecutorError("http_error", response.status, {
        retryAfter: response.headers.get("retry-after") ?? undefined,
      });
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId && !headers["mcp-session-id"]) {
      headers["mcp-session-id"] = sessionId;
    }
    const text = await readBody(
      response,
      signal,
      options.maxBytes ?? 8 * 1024 * 1024
    );
    if (id === undefined) {
      return;
    }
    const message = rpcMessage(text, id);
    if (message.error !== undefined) {
      throw new ExecutorError("rpc_error");
    }
    return message.result;
  };
  const initialized = await post(
    {
      id: 1,
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "foreman", version: "1" },
        protocolVersion: "2025-06-18",
      },
    },
    1
  );
  if (initialized?.protocolVersion !== "2025-06-18") {
    throw new ExecutorError("unsupported_protocol");
  }
  headers["MCP-Protocol-Version"] = "2025-06-18";
  await post({ method: "notifications/initialized" });
  // JSON quoting is for TypeScript source here, never for a shell command.
  // From this point onward, losing the response cannot prove the write failed.
  markDispatched();
  const result = await post(
    {
      id: 2,
      method: "tools/call",
      params: { arguments: { code }, name: "execute" },
    },
    2
  );
  const outcome = result?.structuredContent;
  if (
    result?.isError ||
    outcome?.status !== "completed" ||
    outcome.execution?.ok !== true
  ) {
    throw new ExecutorError("execution_unavailable");
  }
  return outcome.execution.value;
}

function describeExecutorOperation(ctx: ExecutorRequestContext, path: string) {
  if (!OPERATION_PATH.test(path) || path.startsWith("executor.")) {
    throw new ExecutorError("invalid_operation_binding");
  }
  return executeExecutor(
    ctx,
    `return await tools.search.describe({paths:[${JSON.stringify(path)}]});`
  );
}

/** Internal wire adapter. Only dispatch.ts and transport tests may import this value. */
export const executorTransport = {
  call: invokeExecutor,
  describe: describeExecutorOperation,
};
