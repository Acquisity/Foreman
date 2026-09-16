import { getToken as getConnectToken } from "@vercel/connect";
import type { ToolContext } from "eve/tools";
import {
  assertFinCaseSource,
  FIN_CASE_TEAM,
  type FinCaseDecision,
  finCaseIdentifier,
  finCaseIssue,
  finCaseList,
  finCaseSearch,
  finCaseSource,
} from "../fin-case.js";
import { type FinLinearCall, fileFinCase } from "../fin-case-filing.js";
import {
  isFinInvestigation,
  requireFinInvestigationContext,
} from "../fin-investigation-auth.js";
import {
  finLearnIdentifiers,
  finUnknownIdentifier,
} from "../fin-provenance.js";
import { providerData } from "../support/conversation.js";
import { supportOperationPolicy } from "../support/policy.js";
import { executorAuth } from "./auth.js";
import { type ExecutorToolkit, FIN_PREVIEW_TOOLKIT } from "./endpoint.js";
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
  // A verified customer investigation reaches its own toolkit; everything else
  // keeps the toolkit its policy names, or the shared company one.
  const toolkit: ExecutorToolkit | undefined =
    policy?.toolkit ??
    (isFinInvestigation(ctx.session?.auth.initiator)
      ? FIN_PREVIEW_TOOLKIT
      : undefined);
  return {
    authorization,
    wire: { signal: ctx.abortSignal, token, toolkit },
  };
}

const FIN_SQL_MAX = 20_000;
const REGEX_LITERAL = /[.*+?^${}()|[\]\\]/g;
/**
 * A comment hides the verified id from every check below it, and a statement
 * separator puts a whole second query behind one that passed.
 */
const SQL_COMMENT = /--|\/\*|;/;
/** A second select is a second tenant. */
const SQL_UNION = /\bunion\b/i;
/**
 * Every negation that turns the bind into its complement or wraps it.
 * `is not null` stays available; `not (` does not, because it can invert the
 * bind itself without ever touching the organization column directly.
 */
const SQL_NEGATION = /!=|<>|\bnot\s+in\b|\bnot\s*\(/i;
/**
 * An organization column and the operator applied to it. Anything the lane
 * legitimately reads compares it either to the verified literal or to another
 * table's organization column, so those two are the whole allowed set and an
 * `in (...)` list or a subquery is not one of them.
 */
const ORGANIZATION_COMPARISON =
  /(?:\b[a-z_][a-z0-9_]*\.)?"?organization_id"?\s*(!=|<>|<=|>=|=|<|>|\bin\b|\blike\b|\bany\b)\s*/gi;
const COLUMN_REFERENCE = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?(?!\s*\()\b/i;

const escapeRegex = (value: string) => value.replace(REGEX_LITERAL, "\\$&");

/**
 * The one input-side control on raw SQL.
 *
 * Raw SQL is the only connection in the toolkit that can aggregate across
 * tenants, so it is the only read that has to prove its scope here rather
 * than at the toolkit. This is not a SQL parser and must not become one. It
 * requires the verified organization id in a real equality predicate, in the
 * shapes the product schema actually uses (`o.id = '<id>'::uuid`, an optional
 * alias, optional quoting), and rejects the constructs that defeat one: a
 * comment, a statement separator, a second select, a negated or wrapped
 * comparison, and an organization column compared to anything but the
 * verified id or another organization column.
 *
 * Its ceiling is that it reads shapes, not meaning: a query that keeps a real
 * bind and widens beside it, `... where o.id = '<id>' or true`, still passes.
 * Closing that needs the toolkit's own read scoping, not a longer regex here.
 */
function finSqlCarriesScope(query: string, organizationId: string): boolean {
  if (query.length > FIN_SQL_MAX) {
    return false;
  }
  if (
    SQL_COMMENT.test(query) ||
    SQL_UNION.test(query) ||
    SQL_NEGATION.test(query)
  ) {
    return false;
  }
  const id = escapeRegex(organizationId);
  const bound = new RegExp(
    `(?:\\b[a-z_][a-z0-9_]*\\.)?"?(?:organization_id|id)"?\\s*=\\s*'${id}'(?:::uuid)?`,
    "i"
  );
  if (!bound.test(query)) {
    return false;
  }
  const literal = new RegExp(`^'${id}'(?:::uuid)?`, "i");
  ORGANIZATION_COMPARISON.lastIndex = 0;
  let match = ORGANIZATION_COMPARISON.exec(query);
  while (match) {
    const tail = query.slice(match.index + match[0].length);
    if (
      match[1] !== "=" ||
      !(literal.test(tail) || COLUMN_REFERENCE.test(tail))
    ) {
      return false;
    }
    match = ORGANIZATION_COMPARISON.exec(query);
  }
  return true;
}

/**
 * The input-side binds for a verified customer investigation.
 *
 * A raw SQL read carries the verified workspace in an equality predicate; see
 * {@link finSqlCarriesScope}. Every Linear ticket call is fixed by the
 * server-owned scope as well: a write carries the conversation link, a search
 * is the scope's own search, and a read names one ticket and nothing else, so
 * caller text can never read or file against another conversation.
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
  const deny = (code: string, reason: string) => {
    throw new ExecutorError(code, 403, { dispatched: false, reason });
  };
  if (
    path.startsWith("planetscale.") &&
    !(
      typeof input.query === "string" &&
      finSqlCarriesScope(input.query, scope.organizationId)
    )
  ) {
    deny(
      "customer_organization_scope_required",
      "A product database read has to select this conversation's own workspace by its verified organization id, in a plain equality, with no comment, second statement, union or negation. Rewrite the query that way and try again. Do not mention this restriction in the reply."
    );
  }
  if (
    path.endsWith(".save_issue") &&
    !(
      input.team === FIN_CASE_TEAM &&
      typeof input.description === "string" &&
      input.description.endsWith(`Intercom source: ${finCaseSource(scope)}`)
    )
  ) {
    deny(
      "customer_scope_required",
      "A ticket for this conversation is filed with the ticket tool, which supplies the team and the conversation link itself. Do not mention this restriction in the reply."
    );
  }
  if (
    path === `${FIN_LINEAR_PREFIX}list_issues` &&
    // Both callers pass finCaseSearch(scope) itself, so the shapes compare exactly.
    JSON.stringify(input) !== JSON.stringify(finCaseSearch(scope))
  ) {
    deny(
      "customer_scope_required",
      "Tickets for this conversation are found with the status tool, which supplies the search itself. Do not mention this restriction in the reply."
    );
  }
  if (
    path === `${FIN_LINEAR_PREFIX}get_issue` &&
    !(
      finCaseIdentifier.safeParse(input.id).success &&
      Object.keys(input).length === 1
    )
  ) {
    deny(
      "customer_scope_required",
      "A ticket read names one ticket by the identifier an earlier scoped read returned, and carries nothing else. Do not mention this restriction in the reply."
    );
  }
  if (finUnknownIdentifier(ctx.session?.id ?? "", scope, input)) {
    deny(
      "customer_identifier_provenance_required",
      "This call names a record that neither belongs to this conversation nor came back from an earlier call in it. Find it first through a read that is scoped to this workspace, then use the value that read returned. Do not mention this restriction in the reply."
    );
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
    const result = await executorTransport.call(wire, path, input, options);
    if (result.ok && isFinInvestigation(ctx.session?.auth.initiator)) {
      finLearnIdentifiers(
        ctx.session?.id ?? "",
        requireFinInvestigationContext(ctx.session?.auth.initiator),
        result.data
      );
    }
    return result;
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
  const policy = supportOperationPolicy(ctx);
  // Describing a dispatcher is permitted; operation arguments are checked only when called.
  policy?.describe(path);
  const { wire } = await connection(ctx, policy);
  return executorTransport.describe(wire, path);
}

export async function searchProvider(
  ctx: ProviderContext,
  query: { namespace?: string; query: string }
) {
  const { wire } = await connection(ctx, supportOperationPolicy(ctx));
  return executorTransport.search(wire, query);
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
  // Only an untruncated empty page proves no ticket exists. Anything else is
  // unknown, and the caller reports that rather than asserting absence.
  if (found.hasNextPage || found.issues.length > 1) {
    throw new Error(
      "The ticket for this conversation could not be identified."
    );
  }
  if (!found.issues.length) {
    return null;
  }
  const issue = finCaseIssue.parse(
    await call("get_issue", { id: found.issues[0].id })
  );
  assertFinCaseSource(issue, scope);
  return { checked_at: new Date().toISOString(), status: issue.statusType };
}
