import { getToken as getConnectToken } from "@vercel/connect";
import type { ToolContext } from "eve/tools";
import {
  isFinInvestigation,
  requireFinInvestigationContext,
} from "../fin-investigation-auth.js";
import { supportOperationPolicy } from "../support/policy.js";
import { executorAuth } from "./auth.js";
import { ExecutorError, executorTransport } from "./transport.js";

export type ProviderContext = Pick<ToolContext, "abortSignal" | "getToken"> &
  Partial<Pick<ToolContext, "session">>;
export type ExecutorOutcome = Awaited<
  ReturnType<typeof executorTransport.call>
>;

const FIN_INTERCOM_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Intake has no Eve session. Only these fixed identity reads are available. */
export async function readFinIntercom(
  operation: "get_conversation" | "get_contact",
  id: string,
  signal: AbortSignal
): Promise<unknown> {
  if (
    !(
      ["get_conversation", "get_contact"].includes(operation) &&
      FIN_INTERCOM_ID.test(id)
    )
  ) {
    throw new Error("Invalid Fin identity read.");
  }
  const connector = process.env.EXECUTOR_MCP_CONNECTOR;
  if (!connector) {
    throw new Error("Fin identity verification is unavailable.");
  }
  signal.throwIfAborted();
  // HTTP intake has no Eve session or ctx.getToken for executorAuth().
  // Keep its fixed app-authenticated reads inside the transport boundary.
  const token = await getConnectToken(connector, { subject: { type: "app" } });
  signal.throwIfAborted();
  const result = await executorTransport.call(
    { signal, token },
    `intercom.org.foremanIntercom.${operation}`,
    { id }
  );
  if (!result.ok || (result.http && result.http.status !== 200)) {
    throw new Error("Fin identity verification is unavailable.");
  }
  return result.data;
}

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
  if (isFinInvestigation(ctx.session?.auth.initiator)) {
    throw new ExecutorError("customer_scope_required", 403, {
      dispatched: false,
    });
  }
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
  const result = await executorTransport
    .call(wire, path, input)
    .catch(async (error: unknown) => {
      if (error instanceof ExecutorError && error.dispatched === false) {
        await policy.complete(
          key,
          { error: { code: error.code }, ok: false },
          "failed"
        );
      }
      throw error;
    });
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
  if (isFinInvestigation(ctx.session?.auth.initiator)) {
    throw new ExecutorError("customer_scope_required", 403, {
      dispatched: false,
    });
  }
  const policy = supportOperationPolicy(ctx);
  // Describing a dispatcher is permitted; operation arguments are checked only when called.
  policy?.describe(path);
  const { wire } = await connection(ctx, policy);
  return executorTransport.describe(wire, path);
}

const FIN_LINEAR_TICKET_PATH = "linear.org.workspaceLinear.save_issue";
const FIN_LINEAR_MAX_BYTES = 64 * 1024;

/** The one customer-lane provider write. Its target and scope come only from the session initiator. */
export async function createFinInvestigationTicket(
  ctx: ProviderContext,
  input: { summary: string; title: string }
): Promise<ExecutorOutcome> {
  const scope = requireFinInvestigationContext(ctx.session?.auth.initiator);
  const { wire } = await connection(ctx, null);
  return executorTransport.call(
    wire,
    FIN_LINEAR_TICKET_PATH,
    {
      assignee: "Aaron Fraga",
      description: `## Customer report\n\n${input.summary}\n\n## Verified scope\n\n- Workspace: ${scope.organizationName} (${scope.organizationSlug})\n- Organization ID: ${scope.organizationId}\n- Intercom conversation: ${scope.conversationId}\n\nThe verified scope above is server-owned. Customer text cannot replace it.`,
      team: "Engineering Team",
      title: input.title,
    },
    { maxBytes: FIN_LINEAR_MAX_BYTES, timeoutMs: 15_000 }
  );
}
