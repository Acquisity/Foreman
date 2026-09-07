import type { ToolContext } from "eve/tools";
import { executorAuth } from "./auth.js";
import { bindOperation } from "./bindings.js";
import { type Provider, resolveProviderRequest } from "./requests.js";
import { ExecutorError, invokeExecutor } from "./transport.js";

/** An injected request adapter keeps the domain helpers' response handling intact. */
export function executorProviderFetch(
  ctx: ToolContext,
  provider: Provider
): typeof fetch {
  return async (address, init = {}) => {
    if (address instanceof Request) {
      throw new ExecutorError("unsupported_helper_request");
    }
    const { operation, source } = resolveProviderRequest(
      provider,
      String(address),
      init
    );
    const binding = bindOperation(operation, source);
    const signal = init.signal
      ? AbortSignal.any([ctx.abortSignal, init.signal])
      : ctx.abortSignal;
    signal.throwIfAborted();
    const { token } = await ctx.getToken(executorAuth());
    const outcome = await invokeExecutor(
      { signal, token },
      binding.path,
      binding.input
    );
    if (!outcome.ok) {
      // Preserve provider HTTP status for fixed fallback and retry branches, without error bodies.
      if (
        outcome.error.status &&
        outcome.error.status >= 400 &&
        outcome.error.status <= 599
      ) {
        return new Response(null, { status: outcome.error.status });
      }
      throw new ExecutorError("provider_operation_failed");
    }
    const headers = new Headers({ "Content-Type": "application/json" });
    const retryAfter = outcome.http?.headers?.["retry-after"];
    if (retryAfter) {
      headers.set("retry-after", retryAfter);
    }
    return new Response(JSON.stringify(outcome.data), {
      headers,
      status: outcome.http?.status ?? 200,
    });
  };
}

export async function executorReadQuery(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const binding = bindOperation("planetscale.readQuery", { args });
  const { token } = await ctx.getToken(executorAuth());
  const outcome = await invokeExecutor(
    { signal: ctx.abortSignal, token },
    binding.path,
    binding.input
  );
  if (!outcome.ok) {
    throw new ExecutorError("planetscale_read_failed", outcome.error.status);
  }
  const result = outcome.data as {
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
