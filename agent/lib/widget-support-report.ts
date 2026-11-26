import { acquisityOrigin } from "./acquisity-origin.js";
import { logOpsEvent } from "./ops-log.js";
import type { WidgetContext } from "./widget-scope.js";
import { commentIdFor, linearAppRequest } from "./widget-ticket-followup.js";
import { WIDGET_SCOPE_NOTICE } from "./widget-ticket-marker.js";

/**
 * Where a widget ticket keeps what is not for its body (ENG-21100): the chat it
 * belongs to is a "Support chat" link attachment, the URL Fixy's readers and
 * the support inbox already use, and the verified scope, ids, conversation and
 * evidence are an issue document titled "Support report". The description
 * reads like any other ticket.
 */
export const SUPPORT_CHAT_TITLE = "Support chat";
export const SUPPORT_REPORT_TITLE = "Support report";

/** The last line of every widget ticket body. */
export const SUPPORT_REPORT_POINTER =
  "The conversation, the verified workspace and the ids are in the Support report document attached to this ticket.";

/** The admin inbox link to one support conversation, as Fixy's `supportConversationOf` reads it. */
export const supportChatUrl = (conversationId: string) => {
  const url = new URL("/dashboard/admin/support", acquisityOrigin());
  url.searchParams.set("conversation", conversationId);
  return url.toString();
};

const SUPPORT_CHAT_PATH = "/dashboard/admin/support";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The conversation a support chat link names, or null for any other URL. */
export const linkedConversation = (url: string): string | null => {
  const parsed = URL.parse(url);
  const conversation = parsed?.searchParams.get("conversation") ?? null;
  return parsed?.pathname === SUPPORT_CHAT_PATH &&
    conversation &&
    UUID.test(conversation)
    ? conversation
    : null;
};

/**
 * Whether an attachment is the link Foreman puts on a widget ticket. The
 * support inbox links tickets to the same URL under its own title; those are
 * a teammate's tickets, so they are not reused or treated as widget intake.
 */
export const isSupportChatLink = (link: { title: string; url: string }) =>
  link.title === SUPPORT_CHAT_TITLE && linkedConversation(link.url) !== null;

/** What filed the ticket, in the words the Support report uses. */
export type WidgetEntry = "bug" | "handoff" | "problem" | "tool";

const ENTRY: Record<WidgetEntry, string> = {
  bug: 'the support chat\'s "I found a bug" button',
  handoff: "Foreman, in place of a handoff to a person",
  problem: 'the customer\'s "Report a problem" in the support chat',
  tool: "Foreman's investigation",
};

/** Outside text kept literal, so it cannot become markup in a ticket or report. */
export const inert = (text: string) =>
  text.replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const UUID_ANYWHERE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/**
 * A ticket title or body with record ids taken out: a customer who pastes a
 * campaign or workspace id gets it in the Support report, never the ticket.
 */
export const withoutIds = (text: string) =>
  text.replace(UUID_ANYWHERE, "(id in the Support report)");

/**
 * The document's opening: who and where, from the server-verified scope
 * only, never from the customer's text or a model.
 */
export const verifiedScopeSection = (
  scope: WidgetContext,
  entry: WidgetEntry,
  runId?: string
) =>
  [
    "## Verified scope",
    [
      `- Workspace: ${inert(scope.organizationName)} (${scope.organizationSlug})`,
      `- Workspace ID: ${scope.organizationId}`,
      `- Support conversation: ${scope.conversationId}`,
      `- Support chat: ${supportChatUrl(scope.conversationId)}`,
      `- User: ${scope.userId} (${scope.role})`,
      ...(runId ? [`- Foreman run: ${runId}`] : []),
      `- Filed from ${ENTRY[entry]}`,
    ].join("\n"),
    WIDGET_SCOPE_NOTICE,
  ].join("\n\n");

/** Linear's document content bound is generous; this keeps one report readable. */
const CONTENT_MAX = 60_000;
const CUT = "\n\n(Earlier text cut to fit.)\n\n";
/** Always room for the verified scope, which a workspace name and slug can stretch past a thousand characters. */
const HEAD_KEPT = 2500;

/**
 * Keeps the opening and the end, cutting from the middle, so the verified
 * scope and the newest section, whose last line the widget-feedback route
 * reads, always survive.
 */
export const fitReport = (head: string, tail: string) => {
  if (head.length + tail.length <= CONTENT_MAX) {
    return `${head}${tail}`;
  }
  const kept = Math.min(
    head.length,
    Math.max(HEAD_KEPT, CONTENT_MAX - CUT.length - tail.length)
  );
  return `${head.slice(0, kept)}${CUT}${tail.slice(-(CONTENT_MAX - CUT.length - kept))}`;
};

export const supportReportContent = (
  scope: WidgetContext,
  entry: WidgetEntry,
  sections: string[],
  runId?: string
) =>
  fitReport(
    `${verifiedScopeSection(scope, entry, runId)}\n\n`,
    sections.join("\n\n")
  );

/**
 * A widget ticket is delegated as it is created and its Support report is
 * written just after, so a session can open first: the pre-model reads wait
 * for the report a little, inside the 7s gate, before going on without it.
 */
export const REPORT_WAITS_MS = [1000, 1500, 2500];

/** Whether a description is a widget ticket's body, which ends with the pointer to its Support report. */
export const isWidgetTicketBody = (description: string | null) =>
  (description ?? "").trimEnd().endsWith(SUPPORT_REPORT_POINTER);

/** Reads again after each wait until `ready` holds, then returns the last read. */
export async function readUntilReport<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  waits: number[]
): Promise<T> {
  let value = await read();
  for (const ms of waits) {
    if (ready(value)) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: each wait gives the report time to land.
    await new Promise((resolve) => setTimeout(resolve, ms));
    value = await read();
  }
  return value;
}

/** One fixed document id per ticket, so a retried filing never adds a second report. */
export const supportReportId = (identifier: string) =>
  commentIdFor(`support-report:${identifier}`);

const CREATE = `mutation SupportReportCreate($input: DocumentCreateInput!) {
  documentCreate(input: $input) { success }
}`;
const READ =
  "query SupportReportRead($id: String!) { document(id: $id) { content } }";
const UPDATE = `mutation SupportReportUpdate($id: String!, $input: DocumentUpdateInput!) {
  documentUpdate(id: $id, input: $input) { success }
}`;

// eve's LinearApiError keeps Linear's own errors in `body`; this one means the id is taken.
const TAKEN = /conflict on insert of Document/u;

/** Create, or read and update: three requests at most. */
const REPORT_WRITE_MS = 30_000;

/** The line that marks one filing's addition, so a retried filing adds nothing twice. */
export const additionMark = (key: string) =>
  `<!-- support-report-addition ${key} -->`;

const unsaved = (conversationId: string) => {
  logOpsEvent("widget.ticket.report_unsaved", { conversationId }, console.warn);
  return false;
};

/**
 * Writes the ticket's Support report with Foreman's own Linear app token, or,
 * when the ticket already has one, adds `addition` to its end unless that
 * filing's mark is already there. Never throws: the ticket is already filed
 * and linked to its chat, so a failed or refused write is logged and returns
 * false. It runs under its own deadline, so a cancelled turn cannot turn a
 * filed ticket into a failure.
 */
export async function saveSupportReport(
  identifier: string,
  content: string,
  addition: { key: string; text: string },
  ids: { conversationId: string },
  request: typeof linearAppRequest = linearAppRequest
): Promise<boolean> {
  const signal = AbortSignal.timeout(REPORT_WRITE_MS);
  const id = supportReportId(identifier);
  const mark = additionMark(addition.key);
  try {
    try {
      const created = await request<{ documentCreate: { success: boolean } }>(
        "SupportReportCreate",
        CREATE,
        {
          input: {
            content: `${mark}\n\n${content}`,
            id,
            issueId: identifier,
            title: SUPPORT_REPORT_TITLE,
          },
        },
        signal
      );
      return created.documentCreate.success || unsaved(ids.conversationId);
    } catch (error) {
      const refusal = (error as { body?: unknown } | null)?.body;
      if (signal.aborted || !TAKEN.test(JSON.stringify(refusal ?? null))) {
        throw error;
      }
    }
    const { document } = await request<{
      document: { content: string | null } | null;
    }>("SupportReportRead", READ, { id }, signal);
    const existing = document?.content ?? "";
    if (existing.includes(mark)) {
      return true;
    }
    const updated = await request<{ documentUpdate: { success: boolean } }>(
      "SupportReportUpdate",
      UPDATE,
      {
        id,
        input: {
          content: fitReport(existing, `\n\n${mark}\n\n${addition.text}`),
        },
      },
      signal
    );
    return updated.documentUpdate.success || unsaved(ids.conversationId);
  } catch {
    return unsaved(ids.conversationId);
  }
}

/** A ticket linked to a support chat, with what kind of work it holds. */
export interface LinkedTicket {
  identifier: string;
  kind: TicketKind;
  /** On a feedback ticket, the reply its report is about: a message id, or "none" for the whole chat. */
  reported?: string;
  stateType: string;
  url: string;
}

/**
 * The independent work a chat can hold: an engineering or support case, a
 * refund in billing's queue, and feedback on a Foreman reply. A chat with a
 * bug and a refund gets one of each, never one hiding the other.
 */
export type TicketKind = "case" | "feedback" | "refund";

/**
 * Where a widget refund request lands: the Support project with the Refund
 * label, which is the queue billing triage reads. `project` is how the ticket
 * write names it; `projectId` is how Linear returns it on an issue.
 */
export const REFUND_TICKET = {
  labels: ["9120e30d-e188-4972-940b-20005b7f6d03"],
  project: "P-ENG-20",
  projectId: "4534deb2-6bbc-4e30-ad38-48963f414d14",
} as const;
/** The Acquisity Chat Widget project, where reports on Foreman's replies go. */
export const WIDGET_FEEDBACK_PROJECT_ID =
  "84ab288a-6a7b-4316-ab6f-f67809a40211";

export const ticketKind = (issue: {
  labels: { nodes: { id: string }[] };
  project: { id: string } | null;
}): TicketKind => {
  if (issue.project?.id === WIDGET_FEEDBACK_PROJECT_ID) {
    return "feedback";
  }
  return issue.project?.id === REFUND_TICKET.projectId &&
    issue.labels.nodes.some(({ id }) => id === REFUND_TICKET.labels[0])
    ? "refund"
    : "case";
};

const LINKED = `query SupportChatTickets($url: String!) {
  attachmentsForURL(url: $url, first: 50) {
    nodes {
      title url
      issue {
        identifier url state { type } project { id } labels { nodes { id } }
        documents(first: 1, filter: { title: { eq: "${SUPPORT_REPORT_TITLE}" } }) { nodes { content } }
      }
    }
  }
}`;

interface LinkedResponse {
  attachmentsForURL: {
    nodes: {
      title: string;
      url: string;
      issue: {
        documents: { nodes: { content: string | null }[] };
        identifier: string;
        labels: { nodes: { id: string }[] };
        project: { id: string } | null;
        state: { type: string };
        url: string;
      } | null;
    }[];
  };
}

/** The chat and reply a feedback report is about, from its first machine line. */
const FEEDBACK_LINE =
  /<!-- chat-widget-feedback conversation=([\w-]{1,128}) message=([\w-]{1,128}) /u;

/** Every ticket Foreman linked to this conversation's support chat. */
export async function linkedTickets(
  conversationId: string,
  signal: AbortSignal,
  request: typeof linearAppRequest = linearAppRequest
): Promise<LinkedTicket[]> {
  const { attachmentsForURL } = await request<LinkedResponse>(
    "SupportChatTickets",
    LINKED,
    { url: supportChatUrl(conversationId) },
    signal
  );
  const seen = new Set<string>();
  return attachmentsForURL.nodes.flatMap(({ issue, ...link }) => {
    if (!(issue && isSupportChatLink(link)) || seen.has(issue.identifier)) {
      return [];
    }
    seen.add(issue.identifier);
    const kind = ticketKind(issue);
    const reported = FEEDBACK_LINE.exec(
      issue.documents.nodes[0]?.content ?? ""
    )?.[2];
    return [
      {
        identifier: issue.identifier,
        kind,
        ...(kind === "feedback" && reported ? { reported } : {}),
        stateType: issue.state.type,
        url: issue.url,
      },
    ];
  });
}

const LEGACY_FEEDBACK = `query LegacyFeedbackTicket($id: String!) {
  issue(id: $id) { identifier url description state { type } project { id } }
}`;

/**
 * A report ticket Acquisity filed itself before ENG-21100, which the app
 * still names for the reported reply: it counts only in the Chat Widget
 * project and when its description's machine line names this chat and reply.
 * Its state does not matter: a repeat report only adds to it.
 */
export async function legacyFeedbackTicket(
  identifier: string,
  conversationId: string,
  message: string,
  signal: AbortSignal,
  request: typeof linearAppRequest = linearAppRequest
): Promise<LinkedTicket | null> {
  const { issue } = await request<{
    issue: {
      description: string | null;
      identifier: string;
      project: { id: string } | null;
      state: { type: string };
      url: string;
    } | null;
  }>("LegacyFeedbackTicket", LEGACY_FEEDBACK, { id: identifier }, signal);
  const line = FEEDBACK_LINE.exec(issue?.description ?? "");
  if (
    !issue ||
    issue.project?.id !== WIDGET_FEEDBACK_PROJECT_ID ||
    line?.[1] !== conversationId ||
    line[2] !== message
  ) {
    return null;
  }
  return {
    identifier: issue.identifier,
    kind: "feedback",
    reported: message,
    stateType: issue.state.type,
    url: issue.url,
  };
}
