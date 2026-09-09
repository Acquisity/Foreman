import type { ToolContext } from "eve/tools";
import { supportOperationPolicy } from "../support/policy.js";
import { executorAuth } from "./auth.js";
import { ExecutorError, executorTransport } from "./transport.js";

export type ProviderContext = Pick<ToolContext, "abortSignal" | "getToken"> &
  Partial<Pick<ToolContext, "session">>;
export type ExecutorOutcome = Awaited<
  ReturnType<typeof executorTransport.call>
>;

async function connection(
  ctx: ProviderContext,
  policy: ReturnType<typeof supportOperationPolicy>
) {
  const { token } = await ctx.getToken(executorAuth());
  const authorization = policy ? { version: await policy.authorize() } : null;
  return {
    authorization,
    wire: { signal: ctx.abortSignal, token, toolkit: policy?.toolkit },
  };
}

/** The single authored operation entry: choose policy before authorizing or dispatching. */
export async function invokeProvider(
  ctx: ProviderContext,
  path: string,
  input: Record<string, unknown>,
  operationKey?: string
): Promise<ExecutorOutcome> {
  const policy = supportOperationPolicy(ctx);
  policy?.assert(path, input);
  const { wire, authorization } = await connection(ctx, policy);
  const key =
    policy && authorization
      ? policy.writeKey(path, input, authorization.version, operationKey)
      : null;
  if (!(policy && key)) {
    return executorTransport.call(wire, path, input);
  }
  const reserved = await policy.reserve(key);
  if (!reserved.fresh) {
    const result = reserved.result as ExecutorOutcome;
    await policy.record(path, result);
    return result;
  }
  const result = await executorTransport.call(wire, path, input);
  if (result.ok) {
    const data = result.data as {
      isError?: boolean;
      errors?: unknown[];
    } | null;
    if (data?.isError || data?.errors?.length) {
      throw new ExecutorError("ambiguous_provider_write");
    }
    await policy.complete(key, result, "done");
    await policy.record(path, result);
  } else if (
    [400, 401, 403, 404, 422, 429].includes(result.error.status ?? 0)
  ) {
    await policy.complete(key, result, "failed");
  }
  return result;
}

export async function describeProvider(ctx: ProviderContext, path: string) {
  const policy = supportOperationPolicy(ctx);
  // Describing a dispatcher is permitted; operation arguments are checked only when called.
  policy?.describe(path);
  const { wire } = await connection(ctx, policy);
  return executorTransport.describe(wire, path);
}
