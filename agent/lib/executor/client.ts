import type { ToolContext } from "eve/tools";
import { z } from "zod";
import {
  LINEAR_OPERATIONS,
  type LinearOperation,
} from "../linear-operations.js";
import { executorAuth } from "./auth.js";
import { operationPath } from "./bindings.js";
import {
  operationInputs,
  type ProviderClient,
  type ProviderResult,
} from "./operations.js";
import { ExecutorError, invokeExecutor } from "./transport.js";

const linearInput = z.object({ variables: z.record(z.string(), z.unknown()) });

/** Typed arguments cross one transport boundary; no simulated provider HTTP request. */
export function executorClient(
  ctx: Pick<ToolContext, "abortSignal" | "getToken">
): ProviderClient {
  return async (request, options = {}) => {
    const path = operationPath(request.operation);
    const input = request.operation.startsWith("linear.")
      ? {
          body: {
            query:
              LINEAR_OPERATIONS[request.operation.slice(7) as LinearOperation]
                .document,
            ...linearInput.parse(request.input),
          },
        }
      : operationInputs[
          request.operation as keyof typeof operationInputs
        ].parse(request.input);
    const signal = options.signal
      ? AbortSignal.any([ctx.abortSignal, options.signal])
      : ctx.abortSignal;
    signal.throwIfAborted();
    const { token } = await ctx.getToken(executorAuth());
    let outcome: Awaited<ReturnType<typeof invokeExecutor>>;
    try {
      outcome = await invokeExecutor({ signal, token }, path, input);
    } catch (error) {
      if (
        error instanceof ExecutorError &&
        error.code === "http_error" &&
        error.status === 429
      ) {
        return {
          data: null,
          status: 429,
          ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
        };
      }
      throw error;
    }
    const result = providerResult(outcome);
    const { data } = result;
    if (
      options.maxBytes !== undefined &&
      Buffer.byteLength(JSON.stringify(data), "utf8") > options.maxBytes
    ) {
      throw new ExecutorError("response_too_large");
    }
    return result;
  };
}

function providerResult(
  outcome: Awaited<ReturnType<typeof invokeExecutor>>
): ProviderResult {
  const status = outcome.ok
    ? (outcome.http?.status ?? 200)
    : outcome.error.status;
  if (
    status === undefined ||
    !Number.isInteger(status) ||
    status < 200 ||
    status > 599 ||
    (!outcome.ok && status < 300)
  ) {
    throw new ExecutorError("provider_operation_failed");
  }
  const retryAfter = outcome.ok
    ? Object.entries(outcome.http?.headers ?? {}).find(
        ([name]) => name.toLowerCase() === "retry-after"
      )?.[1]
    : outcome.error.retryAfter;
  const data = outcome.ok ? outcome.data : null;
  return { data, status, ...(retryAfter ? { retryAfter } : {}) };
}

export async function executorReadQuery(
  ctx: Pick<ToolContext, "abortSignal" | "getToken">,
  args: Record<string, unknown>
): Promise<string> {
  const path = operationPath("planetscale.readQuery");
  const input = operationInputs["planetscale.readQuery"].parse(args);
  const { token } = await ctx.getToken(executorAuth());
  const outcome = await invokeExecutor(
    { signal: ctx.abortSignal, token },
    path,
    input
  );
  const normalized = providerResult(outcome);
  if (normalized.status < 200 || normalized.status >= 300) {
    throw new ExecutorError("planetscale_read_failed", normalized.status, {
      retryAfter: normalized.retryAfter,
    });
  }
  const result = normalized.data as {
    isError?: boolean;
    content?: { type?: string; text?: string }[];
  } | null;
  if (result?.isError) {
    throw new ExecutorError("planetscale_read_failed");
  }
  if (!Array.isArray(result?.content)) {
    throw new ExecutorError("invalid_planetscale_result");
  }
  return result.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}
