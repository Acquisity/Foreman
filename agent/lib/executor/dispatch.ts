import { getToken as getConnectToken } from "@vercel/connect";
import type { ToolContext } from "eve/tools";
import type { z } from "zod";
import { finCaseDecision } from "../fin-case.js";
import {
  type FinLinearCall,
  fileFinCase,
  readFinCaseIssue,
} from "../fin-case-filing.js";
import { findFinCases } from "../fin-case-store.js";
import {
  buildFinEvidenceQuery,
  type FinEvidenceInput,
  parseFinEvidence,
} from "../fin-evidence.js";
import {
  isFinInvestigation,
  requireFinInvestigationContext,
} from "../fin-investigation-auth.js";
import type { FinContext } from "../fin-scope.js";
import { PRODUCTION_READ_QUERY_ARGS } from "../lookup-customer.js";
import { logOpsEvent } from "../ops-log.js";
import { supportOperationPolicy } from "../support/policy.js";
import { executorAuth } from "./auth.js";
import { operationPath } from "./bindings.js";
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

function assertLaneOperation(ctx: ProviderContext) {
  if (isFinInvestigation(ctx.session?.auth.initiator)) {
    throw new ExecutorError("customer_scope_required", 403, {
      dispatched: false,
    });
  }
}

/** The single authored operation entry: choose policy before authorizing or dispatching. */
export async function invokeProvider(
  ctx: ProviderContext,
  path: string,
  input: Record<string, unknown>,
  operationKey?: string,
  options: { maxBytes?: number; timeoutMs?: number } = {}
): Promise<ExecutorOutcome> {
  assertLaneOperation(ctx);
  const policy = supportOperationPolicy(ctx);
  policy?.assert(path, input);
  const { wire, authorization } = await connection(ctx, policy);
  const key =
    policy && authorization
      ? policy.writeKey(path, input, authorization.version, operationKey)
      : null;
  if (!(policy && key)) {
    return executorTransport.call(wire, path, input, options);
  }
  const reserved = await policy.reserve(key);
  if (!reserved.fresh) {
    const result = reserved.result as ExecutorOutcome;
    await policy.record(path, result);
    return result;
  }
  const result = await executorTransport
    .call(wire, path, input, options)
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

/** Authored case workflow owns every operation and identifier. Generic customer dispatch stays denied. */
export function fileFinInvestigationCase(
  ctx: ProviderContext,
  input: z.infer<typeof finCaseDecision>
) {
  const scope = requireFinInvestigationContext(ctx.session?.auth.initiator);
  if (!ctx.session?.id) {
    throw new Error("Investigation session missing.");
  }
  const call: FinLinearCall = async (operation, args) => {
    const { wire } = await connection(ctx, null);
    const result = await executorTransport.call(
      wire,
      `linear.org.workspaceLinear.${operation}`,
      args,
      { maxBytes: 256 * 1024, timeoutMs: 15_000 }
    );
    if (!result.ok) {
      throw new Error("Case provider unavailable.");
    }
    return result.data;
  };
  return fileFinCase(
    scope,
    ctx.session.id,
    finCaseDecision.parse(input),
    call,
    ctx.abortSignal
  );
}

/** Intake can read only an association already selected inside the verified owner boundary. */
export async function readFinCaseStatus(
  scope: FinContext,
  caseId: string,
  signal: AbortSignal
) {
  const [record] = await findFinCases(scope, caseId);
  if (!record?.issue_id) {
    throw new Error("Case unavailable.");
  }
  const connector = process.env.EXECUTOR_MCP_CONNECTOR;
  if (!connector) {
    throw new Error("Case provider unavailable.");
  }
  const token = await getConnectToken(connector, { subject: { type: "app" } });
  const call: FinLinearCall = async (operation, input) => {
    if (operation !== "get_issue" || input.id !== record.issue_id) {
      throw new Error("Case read denied.");
    }
    const result = await executorTransport.call(
      { signal, token },
      `linear.org.workspaceLinear.${operation}`,
      input,
      { maxBytes: 256 * 1024, timeoutMs: 15_000 }
    );
    if (!result.ok) {
      throw new Error("Case provider unavailable.");
    }
    return result.data;
  };
  const issue = await readFinCaseIssue(call, record.issue_id, record.scope);
  return { state: issue.statusType };
}

/** Customer reads accept purposes and local IDs, never a provider path or SQL. */
export async function readFinEvidence(
  ctx: ProviderContext,
  input: FinEvidenceInput
) {
  const scope = requireFinInvestigationContext(ctx.session?.auth.initiator);
  const query = buildFinEvidenceQuery(scope, input);
  let stage = "configuration";
  try {
    ctx.abortSignal.throwIfAborted();
    const path = operationPath("planetscale.readQuery");
    if (
      path !==
      "planetscale.org.foremanPlanetscale.planetscale_execute_read_query"
    ) {
      throw new Error("Unexpected evidence operation binding.");
    }
    stage = "transport";
    const { wire } = await connection(ctx, null);
    ctx.abortSignal.throwIfAborted();
    const result = await executorTransport.call(
      wire,
      path,
      { ...PRODUCTION_READ_QUERY_ARGS, query, use_replica: false },
      { maxBytes: 128 * 1024, timeoutMs: 50_000 }
    );
    if (!result.ok || (result.http && result.http.status !== 200)) {
      throw new Error("Evidence provider unavailable.");
    }
    stage = "response";
    return parseFinEvidence(result.data, scope, input);
  } catch (error) {
    if (ctx.abortSignal.aborted) {
      throw error;
    }
    // Parser and provider errors may contain customer rows or credentials. Never forward them.
    logOpsEvent(
      "fin.investigation.evidence.failed",
      {
        code: stage,
        outcome: "error",
        tool: "read_fin_outreach_evidence",
      },
      console.warn
    );
    return {
      message:
        "Saved outreach evidence could not be checked. This is not an empty result.",
      status: "unavailable" as const,
    };
  }
}
