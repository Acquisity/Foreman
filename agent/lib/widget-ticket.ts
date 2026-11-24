import { z } from "zod";
import { appProviderContext } from "./executor/app-context.js";
import { executorClient } from "./executor/client.js";
import {
  createWidgetTicket,
  type ProviderContext,
  REFUND_TICKET,
} from "./executor/dispatch.js";
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
import { isLiveActive, LIVE_TICKET } from "./widget-live-policy.js";
import { isRefundTicket } from "./widget-next-action.js";
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
import {
  followUpOnTicket,
  ownsConversation,
  type TicketNote,
  ticketNote,
} from "./widget-ticket-followup.js";

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
  followUp: followUpOnTicket,
  owns: ownsConversation,
  readReceipt: readWidgetTicketReceipt,
  refund: isRefundTicket,
  saveReceipt: saveWidgetTicketReceipt,
  search: findRelatedIssues,
};

/**
 * One ticket per conversation: every widget ticket carries the conversation id
 * in its server-written scope block, so an earlier one is found by it. The
 * search matches the id anywhere, so a hit counts only once its description
 * shows that block. A ticket someone cancelled no longer covers this
 * conversation.
 */
export async function conversationTicket(
  ctx: ProviderContext,
  search: typeof findRelatedIssues = findRelatedIssues,
  owns: typeof ownsConversation = ownsConversation
): Promise<RelatedIssue | undefined> {
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  const earlier = await search(
    {
      phrases: [scope.conversationId],
      scope: "duplicates",
      windowed: false,
    },
    { client: executorClient(ctx), signal: ctx.abortSignal }
  );
  for (const issue of earlier.issues) {
    if (
      issue.stateType !== "canceled" &&
      // biome-ignore lint/performance/noAwaitInLoops: the first owned hit wins, and there is almost always one.
      (await owns(issue.identifier, scope, ctx.abortSignal))
    ) {
      return issue;
    }
  }
  return undefined;
}

/** `bug` is a whole description in the bug format, filed with the Bug label instead of the customer-report block. */
export interface WidgetTicketInput {
  bug?: string;
  summary: string;
  title: string;
}

/**
 * The conversation's existing ticket, for a turn that needs the team again:
 * it lands on the ticket its owner already holds. Without a run there is no
 * fixed comment id, so nothing is added.
 */
async function reuseTicket(
  ctx: ProviderContext,
  existing: RelatedIssue,
  input: WidgetTicketInput,
  refund: boolean,
  runId: string | undefined,
  followUp: typeof followUpOnTicket
) {
  if (runId) {
    await followUp(existing, input.summary, runId, ctx.abortSignal);
  }
  const opts = { client: executorClient(ctx), signal: ctx.abortSignal };
  return existingTicket(
    existing,
    refund && (await inRefundQueue(existing.identifier, opts))
  );
}

/**
 * File this verified conversation's one ticket, or return the one it already
 * has. widget_file_ticket runs it in the investigator session; the handoff
 * rule and the bug report run it with `appTicketContext` instead.
 */
export async function fileWidgetTicket(
  ctx: ProviderContext,
  input: WidgetTicketInput,
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
    if (isLiveActive()) {
      return await confirm(LIVE_TICKET);
    }
    const refund = input.bug
      ? false
      : await deps.refund(input, ctx.abortSignal);
    const existing = await conversationTicket(ctx, deps.search, deps.owns);
    if (existing) {
      return await confirm(
        await reuseTicket(ctx, existing, input, refund, runId, deps.followUp)
      );
    }
    const result = await deps.create(ctx, {
      bug: Boolean(input.bug),
      refund,
      report: input.bug ?? formatCustomerReport(input.summary),
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
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
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
    ...appProviderContext(signal),
    // Providers read only the session's auth; there is no session id or turn here.
    session: { auth: { current: initiator, initiator } },
  } as unknown as ProviderContext;
};

/** Filed from code, outside a session: a live re-run files nothing, as its ticket tool does. */
export const fileTicketFor = (
  scope: WidgetContext,
  input: WidgetTicketInput,
  signal: AbortSignal,
  runId?: string,
  deps: Partial<typeof ticketDependencies> = {}
): Promise<WidgetTicketResult | typeof LIVE_TICKET> =>
  fileWidgetTicket(appTicketContext(scope, signal, runId), input, deps);

const NOTE_MS = 5000;

/**
 * For a follow-up: the conversation's ticket, where it stands and the team's
 * closing comment, as server-owned notes for the writers and the
 * investigator (see `ticketNote`). Null with no ticket, on a teammate's run,
 * or when it cannot be read in time; a follow-up is answered without it
 * rather than late.
 */
export async function conversationTicketNote(
  scope: WidgetContext,
  signal: AbortSignal
): Promise<TicketNote | null> {
  if (scope.source !== "widget" || isLiveActive()) {
    return null;
  }
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(NOTE_MS)]);
  try {
    const ticket = await conversationTicket(appTicketContext(scope, bounded));
    return ticket ? await ticketNote(ticket.identifier, bounded) : null;
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return null;
  }
}
