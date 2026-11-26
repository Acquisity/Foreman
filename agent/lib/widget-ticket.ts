import { z } from "zod";
import { appProviderContext } from "./executor/app-context.js";
import { executorClient } from "./executor/client.js";
import {
  createWidgetTicket,
  type ProviderContext,
} from "./executor/dispatch.js";
import {
  findRelatedIssues,
  type LinearGraphqlOptions,
  linearGraphql,
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
  type LinkedTicket,
  linkedTickets,
  saveSupportReport,
  supportReportContent,
  type TicketKind,
  ticketKind,
  type WidgetEntry,
} from "./widget-support-report.js";
import {
  followUpOnTicket,
  ownsConversation,
  type TicketNote,
  ticketNote,
} from "./widget-ticket-followup.js";

interface RoutedIssue {
  issue: {
    labels: { nodes: { id: string }[] };
    project: { id: string } | null;
  } | null;
}

/**
 * The kind of work an old ticket holds, read from its project and labels. A
 * ticket that cannot be read counts as a case, so a refund is never folded
 * into it.
 */
export async function legacyKind(
  identifier: string,
  opts: LinearGraphqlOptions
): Promise<TicketKind> {
  try {
    const { issue } = await linearGraphql<RoutedIssue>(
      "RouteIssue",
      { id: identifier },
      opts
    );
    return issue ? ticketKind(issue) : "case";
  } catch (error) {
    if (opts.signal?.aborted) {
      throw error;
    }
    return "case";
  }
}

/**
 * A conversation's existing ticket of the same kind is returned instead of a
 * second one. A refund lands only on a ticket in billing's refund queue, so it
 * is routed to billing by construction.
 */
export const existingTicket = (
  issue: Pick<ConversationTicket, "identifier" | "kind" | "url">
) => ({
  existing: true,
  identifier: issue.identifier,
  refund: issue.kind === "refund",
  url: issue.url,
});

export type WidgetTicketResult = WidgetTicketReceipt | { error: string };

/** A ticket this conversation owns, with the kind of work it holds. */
export type ConversationTicket = LinkedTicket;

const ticketDependencies = {
  create: createWidgetTicket,
  followUp: followUpOnTicket,
  kind: legacyKind,
  linked: linkedTickets,
  owns: ownsConversation,
  readReceipt: readWidgetTicketReceipt,
  refund: isRefundTicket,
  report: saveSupportReport,
  saveReceipt: saveWidgetTicketReceipt,
  search: findRelatedIssues,
};
type TicketDependencies = typeof ticketDependencies;

/**
 * Tickets filed before ENG-21100 carry the conversation id in a
 * server-written scope block at the end of the description instead of a
 * support chat link. The search matches the id anywhere, so a hit counts only
 * once its description shows that block.
 */
async function legacyTickets(
  ctx: ProviderContext,
  scope: WidgetContext,
  deps: Pick<TicketDependencies, "kind" | "owns" | "search">
): Promise<ConversationTicket[]> {
  const opts = { client: executorClient(ctx), signal: ctx.abortSignal };
  const earlier = await deps.search(
    {
      phrases: [scope.conversationId],
      scope: "duplicates",
      windowed: false,
    },
    opts
  );
  const owned: ConversationTicket[] = [];
  for (const issue of earlier.issues) {
    if (
      CLOSED_UNDONE.has(issue.stateType) ||
      // biome-ignore lint/performance/noAwaitInLoops: almost always one hit.
      !(await deps.owns(issue.identifier, scope, ctx.abortSignal))
    ) {
      continue;
    }
    owned.push({
      identifier: issue.identifier,
      kind: await deps.kind(issue.identifier, opts),
      stateType: issue.stateType,
      url: issue.url,
    });
  }
  return owned;
}

/** A ticket someone cancelled or closed as a duplicate no longer covers this conversation. */
const CLOSED_UNDONE = new Set(["canceled", "duplicate"]);

/**
 * The conversation's ticket for one kind of work, or for any work but
 * feedback when no kind is named: first the tickets linked to its support
 * chat, then the old ones whose description ends with its scope block.
 */
export async function conversationTicket(
  ctx: ProviderContext,
  kind?: TicketKind,
  overrides: Partial<
    Pick<TicketDependencies, "kind" | "linked" | "owns" | "search">
  > = {}
): Promise<ConversationTicket | undefined> {
  const deps = { ...ticketDependencies, ...overrides };
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  const wanted = (ticket: ConversationTicket) =>
    !CLOSED_UNDONE.has(ticket.stateType) &&
    (kind ? ticket.kind === kind : ticket.kind !== "feedback");
  const linked = (
    await deps.linked(scope.conversationId, ctx.abortSignal)
  ).find(wanted);
  if (linked || kind === "feedback") {
    return linked;
  }
  return (await legacyTickets(ctx, scope, deps)).find(wanted);
}

/**
 * One widget ticket, as every entry point hands it over: a title and plain
 * body from the one drafting call, and what goes in its Support report.
 */
export interface WidgetTicketInput {
  /** The plain body, with no ids and no code block. */
  body: string;
  entry: WidgetEntry;
  /** The Support report's sections after its verified scope: conversation, findings, evidence. */
  report: string[];
  /** Keys a reused ticket's follow-up comment when there is no run, so a retry adds nothing. */
  retryKey?: string;
  /** What the refund check reads beside the title. */
  summary: string;
  title: string;
}

/** The kind a filing is, before anything is read: a bug, a report on a reply, or a refund or other case. */
const filingKind = async (
  input: WidgetTicketInput,
  refund: TicketDependencies["refund"],
  signal: AbortSignal
): Promise<TicketKind | "bug"> => {
  if (input.entry === "bug") {
    return "bug";
  }
  if (input.entry === "problem") {
    return "feedback";
  }
  return (await refund(input, signal)) ? "refund" : "case";
};

/**
 * File this verified conversation's ticket for this kind of work, or return
 * the one it already has. Every widget ticket is filed here: the
 * investigator's widget_file_ticket, the handoff and blocked replies, the bug
 * button, refunds and the customer's Report a problem. A chat with a bug and
 * a refund gets a ticket for each, both linked to the chat.
 */
export async function fileWidgetTicket(
  ctx: ProviderContext,
  input: WidgetTicketInput,
  overrides: Partial<TicketDependencies> = {}
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
    if (saved && isLiveActive()) {
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
    const kind = await filingKind(input, deps.refund, ctx.abortSignal);
    // A run that asks for a bug and then a refund files each once.
    if (
      saved &&
      (!("refund" in saved) || saved.refund === (kind === "refund"))
    ) {
      return saved;
    }
    const report = (identifier: string, addition: string[]) =>
      deps.report(
        identifier,
        supportReportContent(scope, input.entry, input.report, runId),
        [`## Added ${new Date().toISOString()}`, ...addition].join("\n\n"),
        scope,
        ctx.abortSignal
      );
    const existing = await conversationTicket(
      ctx,
      kind === "bug" ? "case" : kind,
      deps
    );
    if (existing) {
      const key = runId ?? input.retryKey;
      // Without a run or retry key there is no fixed comment id, so nothing is added.
      if (key) {
        await deps.followUp(existing, input.body, key, ctx.abortSignal);
        await report(existing.identifier, input.report);
      }
      return await confirm(existingTicket(existing));
    }
    const result = await deps.create(ctx, {
      body: formatCustomerReport(input.body),
      kind,
      title: input.title,
    });
    if (!result.ok) {
      return { error: "Linear did not accept the ticket." };
    }
    let filed: { identifier: string; url: string };
    try {
      filed = confirmedIssue(result.data);
    } catch {
      return {
        error:
          "Linear accepted the request but did not return a confirmed ticket. Do not retry automatically.",
      };
    }
    await report(filed.identifier, input.report);
    return await confirm({
      existing: false,
      refund: kind === "refund",
      ...filed,
    });
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
