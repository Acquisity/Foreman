import { getToken as getConnectToken } from "@vercel/connect";
import { z } from "zod";
import { executorClient } from "./executor/client.js";
import {
  createWidgetTicket,
  type ProviderContext,
  REFUND_TICKET,
} from "./executor/dispatch.js";
import { ExecutorError } from "./executor/transport.js";
import {
  findRelatedIssues,
  type LinearGraphqlOptions,
  linearGraphql,
  type RelatedIssue,
} from "./linear-api.js";
import {
  confirmedIssue,
  formatCustomerReport,
} from "./linear-ticket-report.js";
import { logOpsEvent } from "./ops-log.js";
import { isRefundTicket } from "./widget-next-action.js";
import {
  isLiveActive,
  isReplayActive,
  LIVE_TICKET,
  REPLAY_TICKET,
} from "./widget-replay.js";
import {
  readWidgetTicketReceipt,
  saveWidgetTicketReceipt,
  type WidgetTicketReceipt,
} from "./widget-run-store.js";
import {
  requireWidgetContext,
  type WidgetContext,
  widgetAuth,
} from "./widget-scope.js";

/** REFUND_TICKET.project (P-ENG-20, "Support") as the id Linear returns for an issue's project. */
const SUPPORT_PROJECT_ID = "4534deb2-6bbc-4e30-ad38-48963f414d14";

interface RoutedIssue {
  issue: {
    labels: { nodes: { id: string }[] };
    project: { id: string } | null;
  } | null;
}

/**
 * Whether an existing ticket already sits in the queue billing triage reads:
 * the Support project with the Refund label, the destination REFUND_TICKET
 * files to. A ticket that cannot be read counts as not routed.
 */
export async function inRefundQueue(
  identifier: string,
  opts: LinearGraphqlOptions
): Promise<boolean> {
  try {
    const { issue } = await linearGraphql<RoutedIssue>(
      "RouteIssue",
      { id: identifier },
      opts
    );
    return Boolean(
      issue?.project?.id === SUPPORT_PROJECT_ID &&
        issue.labels.nodes.some(({ id }) => id === REFUND_TICKET.labels[0])
    );
  } catch (error) {
    if (opts.signal?.aborted) {
      throw error;
    }
    return false;
  }
}

/**
 * A conversation's existing ticket is returned instead of a second one. It
 * counts as routed to billing only when it is verified in the refund queue;
 * an ordinary ticket reused for a refund leaves the handoff to a person.
 */
export const existingTicket = (
  issue: Pick<RelatedIssue, "identifier" | "url">,
  routedRefund: boolean
) => ({
  existing: true,
  identifier: issue.identifier,
  refund: routedRefund,
  url: issue.url,
});

export type WidgetTicketResult = WidgetTicketReceipt | { error: string };

const ticketDependencies = {
  create: createWidgetTicket,
  readReceipt: readWidgetTicketReceipt,
  refund: isRefundTicket,
  saveReceipt: saveWidgetTicketReceipt,
  search: findRelatedIssues,
};

/**
 * File this verified conversation's one ticket, or return the one it already
 * has. widget_file_ticket runs it in the investigator session; the after-hours
 * front door runs it with `appTicketContext` instead.
 */
export async function fileWidgetTicket(
  ctx: ProviderContext,
  input: { summary: string; title: string },
  overrides: Partial<typeof ticketDependencies> = {}
): Promise<WidgetTicketResult> {
  const deps = { ...ticketDependencies, ...overrides };
  if (isLiveActive() && !overrides.readReceipt && !overrides.saveReceipt) {
    const { liveRunStore } = await import("./widget-live-store.js");
    const store = liveRunStore();
    deps.readReceipt = store.readTicket;
    deps.saveReceipt = store.saveTicket;
  }
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  // The active turn's auth changes on each run; the initiator may be an earlier run.
  const runId = z
    .uuid()
    .optional()
    .parse(ctx.session?.auth.current?.attributes?.widgetRunId);
  try {
    const saved = runId
      ? await deps.readReceipt(scope, runId, ctx.abortSignal)
      : null;
    if (saved) {
      return saved;
    }
    // The ticket exists once Linear confirms it, so a failed receipt save
    // must not turn it into an unconfirmed outcome.
    const confirm = async (receipt: WidgetTicketReceipt) => {
      if (runId) {
        await deps
          .saveReceipt(scope, runId, receipt, ctx.abortSignal)
          .catch((error) => {
            if (ctx.abortSignal.aborted) {
              throw error;
            }
            logOpsEvent("widget.ticket.receipt_unsaved", {
              conversationId: scope.conversationId,
              runId,
            });
          });
      }
      return receipt;
    };
    if (isReplayActive() || isLiveActive()) {
      return await confirm(isReplayActive() ? REPLAY_TICKET : LIVE_TICKET);
    }
    const refund = await deps.refund(input, ctx.abortSignal);
    // One ticket per conversation: every widget ticket carries the conversation
    // id in its server-written scope block, so an earlier one is found by it.
    const earlier = await deps.search(
      {
        phrases: [scope.conversationId],
        scope: "duplicates",
        windowed: false,
      },
      { client: executorClient(ctx), signal: ctx.abortSignal }
    );
    // A ticket someone cancelled no longer covers this conversation.
    const [existing] = earlier.issues.filter(
      (issue) => issue.stateType !== "canceled"
    );
    if (existing) {
      const opts = { client: executorClient(ctx), signal: ctx.abortSignal };
      return await confirm(
        existingTicket(
          existing,
          refund && (await inRefundQueue(existing.identifier, opts))
        )
      );
    }
    const result = await deps.create(ctx, {
      refund,
      report: formatCustomerReport(input.summary),
      title: input.title,
    });
    if (!result.ok) {
      return { error: "Linear did not accept the ticket." };
    }
    try {
      return await confirm({
        existing: false,
        refund,
        ...confirmedIssue(result.data),
      });
    } catch {
      return {
        error:
          "Linear accepted the request but did not return a confirmed ticket. Do not retry automatically.",
      };
    }
  } catch (error) {
    if (ctx.abortSignal.aborted) {
      throw error;
    }
    return {
      error:
        "The ticket outcome could not be confirmed. Do not retry automatically.",
    };
  }
}

/** The investigator session's provider context, rebuilt from the verified scope under the app principal. */
export const appTicketContext = (
  scope: WidgetContext,
  signal: AbortSignal,
  runId?: string
): ProviderContext => {
  const initiator = widgetAuth(scope, runId);
  return {
    abortSignal: signal,
    getToken: async () => {
      const connector = process.env.EXECUTOR_MCP_CONNECTOR;
      if (!connector) {
        throw new ExecutorError("executor_not_configured");
      }
      return {
        token: await getConnectToken(connector, { subject: { type: "app" } }),
      };
    },
    // Providers read only the session's auth; there is no session id or turn here.
    session: { auth: { current: initiator, initiator } },
  } as unknown as ProviderContext;
};

/** Filed from code, outside a session: replay and live re-runs file nothing, as their ticket tool does. */
export const fileTicketFor = (
  scope: WidgetContext,
  input: { summary: string; title: string },
  signal: AbortSignal,
  runId?: string,
  deps: Partial<typeof ticketDependencies> = {}
): Promise<WidgetTicketResult | typeof REPLAY_TICKET | typeof LIVE_TICKET> =>
  fileWidgetTicket(appTicketContext(scope, signal, runId), input, deps);
