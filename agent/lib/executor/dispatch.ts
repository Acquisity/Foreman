import { getToken as getConnectToken } from "@vercel/connect";
import type { ToolContext } from "eve/tools";
import {
  assertFinCaseSource,
  FIN_CASE_TEAM,
  type FinCaseDecision,
  finCaseIssue,
  finCaseList,
  finCaseSearch,
  finCaseSource,
} from "../fin-case.js";
import { type FinLinearCall, fileFinCase } from "../fin-case-filing.js";
import {
  buildFinEvidenceQuery,
  type FinEvidenceInput,
  parseFinEvidence,
} from "../fin-evidence.js";
import {
  isFinInvestigation,
  requireFinInvestigationContext,
} from "../fin-investigation-auth.js";
import { PRODUCTION_READ_QUERY_ARGS } from "../lookup-customer.js";
import { logOpsEvent } from "../ops-log.js";
import { providerData } from "../support/conversation.js";
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
const FIN_LINEAR_PREFIX = "linear.org.workspaceLinear.";
const FIN_LINEAR_BOUNDS = { maxBytes: 256 * 1024, timeoutMs: 15_000 };
const FIN_FILING_OPERATIONS = ["list_issues", "save_issue", "get_issue"];
const FIN_STATUS_OPERATIONS = ["list_issues", "get_issue"];

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

/**
 * The customer lane reaches three Linear operations and nothing else. A write
 * additionally has to carry the server-owned conversation link, so caller text
 * can never file a ticket against another conversation.
 */
function assertLaneOperation(
  ctx: ProviderContext,
  path: string,
  input: Record<string, unknown>
) {
  if (!isFinInvestigation(ctx.session?.auth.initiator)) {
    return;
  }
  const scope = requireFinInvestigationContext(ctx.session?.auth.initiator);
  const operation = path.slice(FIN_LINEAR_PREFIX.length);
  const permitted =
    path.startsWith(FIN_LINEAR_PREFIX) &&
    FIN_FILING_OPERATIONS.includes(operation) &&
    (operation !== "save_issue" ||
      (input.team === FIN_CASE_TEAM &&
        typeof input.description === "string" &&
        input.description.endsWith(
          `Intercom source: ${finCaseSource(scope)}`
        )));
  if (!permitted) {
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
  assertLaneOperation(ctx, path, input);
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

/** One bounded Linear surface for the customer lane; the caller names what it may reach. */
function finLinearCall(
  ctx: ProviderContext,
  permitted: readonly string[]
): FinLinearCall {
  return async (operation, input) => {
    if (!permitted.includes(operation)) {
      throw new ExecutorError("customer_scope_required", 403, {
        dispatched: false,
      });
    }
    const result = await invokeProvider(
      ctx,
      `${FIN_LINEAR_PREFIX}${operation}`,
      input,
      undefined,
      FIN_LINEAR_BOUNDS
    );
    if (!result.ok) {
      throw new ExecutorError(result.error.code, result.error.status);
    }
    return providerData(result.data);
  };
}

/** The one customer-lane provider write. Its scope comes only from the session initiator. */
export function fileFinInvestigationCase(
  ctx: ProviderContext,
  input: FinCaseDecision
) {
  const scope = requireFinInvestigationContext(ctx.session?.auth.initiator);
  return fileFinCase(
    scope,
    input,
    finLinearCall(ctx, FIN_FILING_OPERATIONS),
    ctx.abortSignal
  );
}

/** Status is scoped to this session's own conversation and carries no identifier. */
export async function readFinCaseStatusForSession(ctx: ProviderContext) {
  const scope = requireFinInvestigationContext(ctx.session?.auth.initiator);
  const call = finLinearCall(ctx, FIN_STATUS_OPERATIONS);
  const found = finCaseList.parse(
    await call("list_issues", finCaseSearch(scope))
  );
  if (found.hasNextPage || found.issues.length !== 1) {
    return null;
  }
  const issue = finCaseIssue.parse(
    await call("get_issue", { id: found.issues[0].id })
  );
  try {
    assertFinCaseSource(issue, scope);
  } catch {
    return null;
  }
  return { checked_at: new Date().toISOString(), status: issue.statusType };
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
