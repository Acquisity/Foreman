import { getToken as getConnectToken } from "@vercel/connect";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { PRODUCTION_READ_QUERY_ARGS } from "../lookup-customer.js";
import {
  filingScope,
  isCancellable,
  type MigrationTicketScope,
  migrationFiledReport,
  migrationScopeBlock,
  slackThreadPermalink,
} from "../migration-ticket-scope.js";
import { FALLBACK_OWNER, SUPPORT_OWNER } from "../owner-map.js";
import { supportOperationPolicy } from "../support/policy.js";
import { isTriageReplay } from "../triage-replay/mode.js";
import { isQuestionsOnly } from "../trust.js";
import { widgetOperationPolicy } from "../widget-policy.js";
import {
  isWidgetSupport,
  requireWidgetContext,
  type WidgetContext,
} from "../widget-scope.js";
import { WIDGET_SCOPE_NOTICE } from "../widget-ticket-marker.js";
import { executorAuth } from "./auth.js";
import { operationPath } from "./bindings.js";
import {
  DISPUTES_TOOLKIT,
  type ExecutorToolkit,
  WIDGET_TOOLKIT,
} from "./endpoint.js";
import { ExecutorError, executorTransport } from "./transport.js";

export type ProviderContext = Pick<ToolContext, "abortSignal" | "getToken"> &
  Partial<Pick<ToolContext, "session">>;
export type ExecutorOutcome = Awaited<
  ReturnType<typeof executorTransport.call>
>;

const LINEAR_TICKET_PATH = "linear.org.workspaceLinear.save_issue";
const LINEAR_TICKET_MAX_BYTES = 64 * 1024;

/**
 * Where a widget refund request lands: the Support project with the Refund
 * label, which is the queue billing triage reads.
 */
export const REFUND_TICKET = {
  labels: ["9120e30d-e188-4972-940b-20005b7f6d03"],
  project: "P-ENG-20",
} as const;

/** The Foreman Linear agent: delegating a ticket to it opens Foreman's triage session. */
export const FOREMAN_LINEAR_AGENT = "d5325c6f-fbc8-451e-9fed-358667e58ad3";

/** Every widget ticket is Aaron's, with the work delegated to the Foreman Linear agent. */
export const WIDGET_TICKET_OWNER = {
  assignee: SUPPORT_OWNER,
  delegate: FOREMAN_LINEAR_AGENT,
} as const;

/**
 * A migration channel ticket is the form's: James holds it, and the work is
 * delegated to the Foreman Linear agent, which opens triage (ENG-16581).
 */
export const MIGRATION_TICKET_OWNER = {
  assignee: FALLBACK_OWNER,
  delegate: FOREMAN_LINEAR_AGENT,
} as const;

/** What every ticket a lane files into Foreman's triage shares. */
const triageTicketShape = {
  delegate: z.literal(FOREMAN_LINEAR_AGENT),
  description: z.string().min(1).max(16_000),
  state: z.literal("Triage"),
  team: z.literal("Engineering Team"),
  title: z.string().min(1).max(160),
};
const widgetTicketShape = {
  ...triageTicketShape,
  assignee: z.literal(WIDGET_TICKET_OWNER.assignee),
};
/** The migration lane's ticket: the shared shape, its owner, and the thread link. */
const migrationLinearTicketInput = z.strictObject({
  ...triageTicketShape,
  assignee: z.literal(MIGRATION_TICKET_OWNER.assignee),
  links: z.tuple([
    z.strictObject({
      title: z.string().regex(/^Ask from [^\n]{1,100}$/u),
      url: z.string().max(200),
    }),
  ]),
});
/** The only other migration write: cancelling a newer duplicate of this thread the tool verified. */
const migrationCancelInput = z.strictObject({
  id: z.string().regex(/^ENG-\d{1,7}$/u),
  state: z.literal("Canceled"),
});

/** Whether the input is a migration ticket for this scope's own thread. */
const isOwnMigrationTicket = (
  scope: MigrationTicketScope,
  input: Record<string, unknown>
): boolean => {
  const parsed = migrationLinearTicketInput.safeParse(input);
  const filed = parsed.success
    ? migrationFiledReport(parsed.data.description)
    : null;
  return Boolean(
    parsed.success &&
      filed &&
      parsed.data.description.endsWith(
        migrationScopeBlock(scope, filed.reporter)
      ) &&
      parsed.data.links[0].url ===
        slackThreadPermalink(scope.channelId, scope.threadTs)
  );
};

/** Whether a questions-only session's Linear write is one the migration lane may make. */
const isMigrationLaneWrite = (
  ctx: ProviderContext,
  path: string,
  input: Record<string, unknown>
): boolean => {
  const scope = filingScope(ctx.session);
  if (!scope || path !== LINEAR_TICKET_PATH) {
    return false;
  }
  const cancel = migrationCancelInput.safeParse(input);
  return cancel.success
    ? isCancellable(scope, cancel.data.id)
    : isOwnMigrationTicket(scope, input);
};

const widgetLinearTicketInput = z.union([
  z.strictObject(widgetTicketShape),
  z.strictObject({
    ...widgetTicketShape,
    labels: z.tuple([z.literal(REFUND_TICKET.labels[0])]),
    project: z.literal(REFUND_TICKET.project),
  }),
]);

/** Every path the foreman-disputes toolkit binds starts with its connection. */
export const DISPUTE_WRITE_CONNECTION = "foreman_stripe_dispute_write.";

type OperationPolicy =
  | ReturnType<typeof supportOperationPolicy>
  | ReturnType<typeof widgetOperationPolicy>;

/** Lanes with their own toolkit select it here; every other session uses the shared toolkit. */
const operationPolicy = (ctx: ProviderContext): OperationPolicy =>
  supportOperationPolicy(ctx) ?? widgetOperationPolicy(ctx);

/**
 * The toolkit a call runs in. A lane policy wins, so a support or widget
 * session asking for a dispute path is refused by its own allowlist; the
 * dispute write paths otherwise run only in the foreman-disputes toolkit.
 */
const toolkitFor = (
  policy: OperationPolicy,
  path: string
): ExecutorToolkit | undefined =>
  policy?.toolkit ??
  (path.startsWith(DISPUTE_WRITE_CONNECTION) ? DISPUTES_TOOLKIT : undefined);

/** The widget egress gate runs outside any eve session: one fixed read under the app principal. */
export async function readWidgetOwnership(
  query: string,
  signal: AbortSignal
): Promise<unknown> {
  const connector = process.env.EXECUTOR_MCP_CONNECTOR;
  if (!connector) {
    throw new Error("Support identifier resolution is unavailable.");
  }
  const path = operationPath("planetscale.readQuery");
  // Defense in depth: this app-principal read runs outside any eve session and
  // its policy/allowlist, so assert the binding still resolves to the expected
  // planetscale read before dispatching.
  if (
    path !== "planetscale.org.foremanPlanetscale.planetscale_execute_read_query"
  ) {
    throw new Error("Unexpected ownership operation binding.");
  }
  signal.throwIfAborted();
  const token = await getConnectToken(connector, { subject: { type: "app" } });
  signal.throwIfAborted();
  const result = await executorTransport.call(
    { signal, token, toolkit: WIDGET_TOOLKIT },
    path,
    { ...PRODUCTION_READ_QUERY_ARGS, query, use_replica: false },
    { maxBytes: 64 * 1024, timeoutMs: 50_000 }
  );
  if (!result.ok || (result.http && result.http.status !== 200)) {
    throw new Error("Support identifier resolution is unavailable.");
  }
  return result.data;
}

async function connection(
  ctx: ProviderContext,
  policy: OperationPolicy,
  path: string
) {
  const { token } = await ctx.getToken(executorAuth());
  const authorization = policy ? { version: await policy.authorize() } : null;
  return {
    authorization,
    wire: { signal: ctx.abortSignal, token, toolkit: toolkitFor(policy, path) },
  };
}

export const widgetScopeBlock = (scope: WidgetContext) =>
  `## Verified scope\n\n- Workspace: ${scope.organizationName} (${scope.organizationSlug})\n- Organization ID: ${scope.organizationId}\n- Support conversation: ${scope.conversationId}\n\n${WIDGET_SCOPE_NOTICE}`;

// A Linear MCP tool that changes something, or the authored GraphQL write API.
const LINEAR_WRITE_PATH =
  /^(?:foreman_linear_write_api\.|linear\.[^.]+\.[^.]+\.(?:save|create|delete|update|archive|unarchive)_)/u;

function assertLaneOperation(
  ctx: ProviderContext,
  path: string,
  input: Record<string, unknown>
) {
  // A questions-only session writes nothing to Linear, except a ticket-filing
  // channel's own thread ticket in its exact shape (ENG-16581).
  const auth = ctx.session?.auth;
  if (
    auth &&
    (isQuestionsOnly(auth.current) || isQuestionsOnly(auth.initiator)) &&
    LINEAR_WRITE_PATH.test(path) &&
    !isMigrationLaneWrite(ctx, path, input)
  ) {
    throw new ExecutorError("questions_only", 403, { dispatched: false });
  }
  // The widget lane's only write: a ticket whose scope block the server wrote.
  if (
    isWidgetSupport(ctx.session?.auth.initiator) &&
    path === LINEAR_TICKET_PATH
  ) {
    const scope = requireWidgetContext(ctx.session?.auth.initiator);
    const parsed = widgetLinearTicketInput.safeParse(input);
    if (
      !(
        parsed.success &&
        parsed.data.description.endsWith(widgetScopeBlock(scope))
      )
    ) {
      throw new ExecutorError("customer_scope_required", 403, {
        dispatched: false,
      });
    }
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
  if (isTriageReplay()) {
    throw new ExecutorError("triage_replay_closed", 503, { dispatched: false });
  }
  assertLaneOperation(ctx, path, input);
  const policy = operationPolicy(ctx);
  policy?.assert(path, input);
  const { wire, authorization } = await connection(ctx, policy, path);
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
  const policy = operationPolicy(ctx);
  // Describing a dispatcher is permitted; operation arguments are checked only when called.
  policy?.describe(path);
  const { wire } = await connection(ctx, policy, path);
  return executorTransport.describe(wire, path);
}

/** The widget lane's one provider write. Team, state and scope come only from the session initiator. */
export async function createWidgetTicket(
  ctx: ProviderContext,
  input: { refund?: boolean; report: string; title: string }
): Promise<ExecutorOutcome> {
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  return await invokeProvider(
    ctx,
    LINEAR_TICKET_PATH,
    {
      ...(input.refund
        ? { ...REFUND_TICKET, labels: [...REFUND_TICKET.labels] }
        : {}),
      ...WIDGET_TICKET_OWNER,
      description: `${input.report}\n\n${widgetScopeBlock(scope)}`,
      state: "Triage",
      team: "Engineering Team",
      title: input.title,
    },
    undefined,
    { maxBytes: LINEAR_TICKET_MAX_BYTES, timeoutMs: 15_000 }
  );
}

/**
 * A ticket-filing questions-only channel's one provider write (ENG-16581).
 * Owner, team and state are fixed here; the description already ends with the
 * server-written Slack scope block, which the lane gate above re-checks.
 */
export async function createMigrationTicket(
  ctx: ProviderContext,
  input: {
    description: string;
    link: { title: string; url: string };
    title: string;
  }
): Promise<ExecutorOutcome> {
  return await invokeProvider(
    ctx,
    LINEAR_TICKET_PATH,
    {
      ...MIGRATION_TICKET_OWNER,
      description: input.description,
      links: [input.link],
      state: "Triage",
      team: "Engineering Team",
      title: input.title,
    },
    undefined,
    { maxBytes: LINEAR_TICKET_MAX_BYTES, timeoutMs: 15_000 }
  );
}

/** Cancels a newer duplicate this process just filed for the same thread. */
export async function cancelMigrationTicket(
  ctx: ProviderContext,
  identifier: string
): Promise<ExecutorOutcome> {
  return await invokeProvider(
    ctx,
    LINEAR_TICKET_PATH,
    { id: identifier, state: "Canceled" },
    undefined,
    { maxBytes: LINEAR_TICKET_MAX_BYTES, timeoutMs: 15_000 }
  );
}
