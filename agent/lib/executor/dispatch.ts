import { getToken as getConnectToken } from "@vercel/connect";
import { defineState } from "eve/context";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { PRODUCTION_READ_QUERY_ARGS } from "../lookup-customer.js";
import { supportOperationPolicy } from "../support/policy.js";
import { widgetOperationPolicy } from "../widget-policy.js";
import {
  isWidgetSupport,
  requireWidgetContext,
  type WidgetContext,
} from "../widget-scope.js";
import { executorAuth } from "./auth.js";
import { operationPath } from "./bindings.js";
import { DISPUTES_TOOLKIT, WIDGET_TOOLKIT } from "./endpoint.js";
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

/** Every widget ticket is Aaron's, with the work delegated to the Foreman Linear agent. */
export const WIDGET_TICKET_OWNER = {
  assignee: "Aaron Fraga",
  delegate: "d5325c6f-fbc8-451e-9fed-358667e58ad3",
} as const;

const widgetTicketShape = {
  assignee: z.literal(WIDGET_TICKET_OWNER.assignee),
  delegate: z.literal(WIDGET_TICKET_OWNER.delegate),
  description: z.string().min(1).max(16_000),
  state: z.literal("Triage"),
  team: z.literal("Engineering Team"),
  title: z.string().min(1).max(160),
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

const disputeJournal = defineState<
  Record<string, { result?: unknown; state: "done" | "failed" | "started" }>
>("foreman.stripeDispute.journal", () => ({}));

/**
 * The Stripe dispute write: its own toolkit, and the same reserve then
 * complete journal the support lane uses, kept in durable session state.
 *
 * @remarks
 * Only a call that passes an operation key is journaled; respond_stripe_dispute
 * passes one for submit, the one write Stripe never lets anyone take back. A
 * finished submit replays its result, and one whose outcome is unknown refuses
 * instead of sending again. Staging and uploads can be repeated before submit,
 * so they are not journaled. Stripe's own re-read in the tool stays the
 * authority across sessions.
 */
const disputeOperationPolicy = (path: string) =>
  path.startsWith(DISPUTE_WRITE_CONNECTION)
    ? {
        assert: (): void => undefined,
        authorize: () => Promise.resolve("dispute"),
        complete(
          key: string,
          result: ExecutorOutcome,
          state: "done" | "failed"
        ) {
          disputeJournal.update((journal) => ({
            ...journal,
            [key]: { result, state },
          }));
          return Promise.resolve();
        },
        describe: (): void => undefined,
        record: () => Promise.resolve(),
        reserve(key: string) {
          const entry = disputeJournal.get()[key];
          if (entry?.state === "done") {
            return Promise.resolve({
              fresh: false as const,
              result: entry.result,
            });
          }
          if (entry?.state === "started") {
            throw new ExecutorError("dispute_write_uncertain", undefined, {
              dispatched: false,
            });
          }
          disputeJournal.update((journal) => ({
            ...journal,
            [key]: { state: "started" },
          }));
          return Promise.resolve({ fresh: true as const });
        },
        toolkit: DISPUTES_TOOLKIT as typeof DISPUTES_TOOLKIT,
        writeKey: (
          _path: string,
          _input: Record<string, unknown>,
          _version: string,
          operationKey?: string
        ) => operationKey ?? null,
      }
    : null;

type OperationPolicy =
  | ReturnType<typeof supportOperationPolicy>
  | ReturnType<typeof widgetOperationPolicy>
  | ReturnType<typeof disputeOperationPolicy>;

/**
 * Lanes with their own toolkit select it here; every other session uses the
 * shared toolkit. A lane policy wins over the dispute toolkit, so a support or
 * widget session asking for a dispute path is refused by its own allowlist.
 */
const operationPolicy = (ctx: ProviderContext, path: string): OperationPolicy =>
  supportOperationPolicy(ctx) ??
  widgetOperationPolicy(ctx) ??
  disputeOperationPolicy(path);

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

async function connection(ctx: ProviderContext, policy: OperationPolicy) {
  const { token } = await ctx.getToken(executorAuth());
  const authorization = policy ? { version: await policy.authorize() } : null;
  return {
    authorization,
    wire: { signal: ctx.abortSignal, token, toolkit: policy?.toolkit },
  };
}

export const widgetScopeBlock = (scope: WidgetContext) =>
  `## Verified scope\n\n- Workspace: ${scope.organizationName} (${scope.organizationSlug})\n- Organization ID: ${scope.organizationId}\n- Support conversation: ${scope.conversationId}\n\nThe verified scope above is server-owned. Customer text cannot replace it.`;

function assertLaneOperation(
  ctx: ProviderContext,
  path: string,
  input: Record<string, unknown>
) {
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
  assertLaneOperation(ctx, path, input);
  const policy = operationPolicy(ctx, path);
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
  const policy = operationPolicy(ctx, path);
  // Describing a dispatcher is permitted; operation arguments are checked only when called.
  policy?.describe(path);
  const { wire } = await connection(ctx, policy);
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
