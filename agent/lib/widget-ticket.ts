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
  legacyFeedbackTicket,
  linkedTickets,
  saveSupportReport,
  supportReportContent,
  type TicketKind,
  ticketKind,
  type WidgetEntry,
  withoutIds,
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

/** How a follow-up comment on a reused ticket opens, by what brought the chat back. */
const FOLLOW_UP_INTRO: Record<WidgetEntry, string> = {
  bug: "The customer reported this again from the support chat:",
  handoff:
    "Foreman passed this conversation to the team again from the support chat:",
  problem: "The customer used Report a problem again in the support chat:",
  tool: "Foreman passed this conversation to the team again from the support chat:",
};

const ticketDependencies = {
  create: createWidgetTicket,
  followUp: followUpOnTicket,
  kind: legacyKind,
  legacyFeedback: legacyFeedbackTicket,
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

/** The case first, then the refund: a follow-up with no named kind is most often about the product. */
const KIND_ORDER: TicketKind[] = ["case", "refund"];

/**
 * The conversation's ticket for one kind of work, or, with no kind named, its
 * case and else its refund: first the tickets linked to its support chat,
 * then the old ones whose description ends with its scope block. Feedback is
 * found per reported reply (`feedbackTicket`).
 */
export async function conversationTicket(
  ctx: ProviderContext,
  kind?: Exclude<TicketKind, "feedback">,
  overrides: Partial<
    Pick<TicketDependencies, "kind" | "linked" | "owns" | "search">
  > = {}
): Promise<ConversationTicket | undefined> {
  const deps = { ...ticketDependencies, ...overrides };
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  const pick = (tickets: ConversationTicket[]) => {
    const open = tickets.filter(
      ({ stateType }) => !CLOSED_UNDONE.has(stateType)
    );
    for (const wanted of kind ? [kind] : KIND_ORDER) {
      const found = open.find((ticket) => ticket.kind === wanted);
      if (found) {
        return found;
      }
    }
  };
  return (
    pick(await deps.linked(scope.conversationId, ctx.abortSignal)) ??
    pick(await legacyTickets(ctx, scope, deps))
  );
}

/**
 * A customer's report on one Foreman reply ("none" for the whole chat) lands
 * on the ticket already filed for that reply, so each reply is diagnosed on
 * its own ticket: one linked to the chat whose report names it, else the one
 * Acquisity filed for it before ENG-21100, which it names.
 */
async function feedbackTicket(
  scope: WidgetContext,
  report: NonNullable<WidgetTicketInput["feedback"]>,
  signal: AbortSignal,
  deps: Pick<TicketDependencies, "legacyFeedback" | "linked">
): Promise<ConversationTicket | undefined> {
  const linked = (await deps.linked(scope.conversationId, signal)).find(
    (ticket) =>
      ticket.kind === "feedback" &&
      ticket.reported === report.message &&
      !CLOSED_UNDONE.has(ticket.stateType)
  );
  if (linked || !report.earlier) {
    return linked;
  }
  return (
    (await deps.legacyFeedback(
      report.earlier,
      scope.conversationId,
      report.message,
      signal
    )) ?? undefined
  );
}

/**
 * One widget ticket, as every entry point hands it over: a title and plain
 * body from the one drafting call, and what goes in its Support report.
 */
export interface WidgetTicketInput {
  /** The plain body, with no ids and no code block. */
  body: string;
  entry: WidgetEntry;
  /**
   * For a customer's Report a problem: the reply it is about ("none" for the
   * whole chat), and the ticket Acquisity filed for that reply before
   * ENG-21100, when it has one.
   */
  feedback?: { earlier?: string; message: string };
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
  // Only the ask itself: the body and report also carry earlier turns.
  const ask = { summary: input.summary, title: input.title };
  return (await refund(ask, signal)) ? "refund" : "case";
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
    // A run files once: a second ask of another kind files on the next message.
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
    const kind = await filingKind(input, deps.refund, ctx.abortSignal);
    const key = runId ?? input.retryKey;
    const report = (identifier: string) =>
      deps.report(
        identifier,
        supportReportContent(scope, input.entry, input.report, runId),
        {
          key: key ?? identifier,
          text: [`## Added ${new Date().toISOString()}`, ...input.report].join(
            "\n\n"
          ),
        },
        scope,
        ctx.abortSignal
      );
    const existing =
      kind === "feedback"
        ? input.feedback &&
          (await feedbackTicket(scope, input.feedback, ctx.abortSignal, deps))
        : await conversationTicket(ctx, kind === "bug" ? "case" : kind, deps);
    if (existing) {
      // Without a run or retry key there is no fixed comment id, so nothing is added.
      if (key) {
        await deps.followUp(
          existing,
          withoutIds(input.body),
          key,
          ctx.abortSignal,
          FOLLOW_UP_INTRO[input.entry]
        );
        await report(existing.identifier);
      }
      return await confirm(existingTicket(existing));
    }
    const result = await deps.create(ctx, {
      body: withoutIds(formatCustomerReport(input.body)),
      kind,
      title: withoutIds(input.title),
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
    const confirmed = await confirm({
      existing: false,
      refund: kind === "refund",
      ...filed,
    });
    await report(filed.identifier);
    return confirmed;
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
