import { z } from "zod";
import { toolkitUrl } from "./endpoint.js";

const envelopeSchema = z.object({
  error: z.unknown().optional(),
  id: z.union([z.number(), z.string()]),
  result: z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z
        .object({ result: z.unknown().optional(), status: z.string() })
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
      code: z.string(),
      retryAfter: z.string().max(200).optional(),
      status: z.number().optional(),
    }),
    ok: z.literal(false),
  }),
]);

export interface ExecutorRequestContext {
  signal: AbortSignal;
  token: string;
  toolkit?: "foreman" | "foreman-support";
}
export class ExecutorError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly retryAfter: string | undefined;
  constructor(
    code: string,
    status?: number,
    options?: ErrorOptions & { retryAfter?: string }
  ) {
    super(
      `Executor operation failed (${code}${status === undefined ? "" : `, HTTP ${status}`}).`,
      options
    );
    this.name = "ExecutorError";
    this.code = code;
    this.status = status;
    this.retryAfter = options?.retryAfter;
  }
}
const SSE_BLOCK = /\r?\n\r?\n/u;
const SSE_LINE = /\r?\n/u;
const OPERATION_PATH = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){3,}$/u;

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
export async function invokeExecutor(
  ctx: ExecutorRequestContext,
  path: string,
  input: Record<string, unknown>,
  options: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {}
) {
  if (!OPERATION_PATH.test(path) || path.startsWith("executor.")) {
    throw new ExecutorError("invalid_operation_binding");
  }
  const result = await executeExecutor(
    ctx,
    `return await tools[${JSON.stringify(path)}](${JSON.stringify(input)});`,
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
  const result = await post(
    {
      id: 2,
      method: "tools/call",
      params: { arguments: { code }, name: "execute" },
    },
    2
  );
  if (result?.isError || result?.structuredContent?.status !== "completed") {
    throw new ExecutorError("execution_unavailable");
  }
  return result.structuredContent.result;
}

export function describeExecutorOperation(
  ctx: ExecutorRequestContext,
  path: string
) {
  if (!OPERATION_PATH.test(path) || path.startsWith("executor.")) {
    throw new ExecutorError("invalid_operation_binding");
  }
  return executeExecutor(
    ctx,
    `return await tools.describe.tool({path:${JSON.stringify(path)}});`
  );
}
