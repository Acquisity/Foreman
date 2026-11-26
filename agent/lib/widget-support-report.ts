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

const inert = (text: string) =>
  text.replaceAll("<", "&lt;").replaceAll(">", "&gt;");

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

export const supportReportContent = (
  scope: WidgetContext,
  entry: WidgetEntry,
  sections: string[],
  runId?: string
) =>
  [verifiedScopeSection(scope, entry, runId), ...sections]
    .join("\n\n")
    .slice(0, CONTENT_MAX);

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

/**
 * Writes the ticket's Support report with Foreman's own Linear app token, or,
 * when the ticket already has one, adds `addition` to its end. Never throws:
 * the ticket is already filed and linked to its chat, so a failed write is
 * logged and the filing still succeeds.
 */
export async function saveSupportReport(
  identifier: string,
  content: string,
  addition: string,
  ids: { conversationId: string },
  signal: AbortSignal,
  request: typeof linearAppRequest = linearAppRequest
): Promise<boolean> {
  const id = supportReportId(identifier);
  try {
    try {
      const created = await request<{ documentCreate: { success: boolean } }>(
        "SupportReportCreate",
        CREATE,
        {
          input: {
            content,
            id,
            issueId: identifier,
            title: SUPPORT_REPORT_TITLE,
          },
        },
        signal
      );
      return created.documentCreate.success;
    } catch (error) {
      const refusal = (error as { body?: unknown } | null)?.body;
      if (signal.aborted || !TAKEN.test(JSON.stringify(refusal ?? null))) {
        throw error;
      }
    }
    const { document } = await request<{
      document: { content: string | null } | null;
    }>("SupportReportRead", READ, { id }, signal);
    const updated = await request<{ documentUpdate: { success: boolean } }>(
      "SupportReportUpdate",
      UPDATE,
      {
        id,
        input: {
          content: `${document?.content ?? ""}\n\n${addition}`.slice(
            0,
            CONTENT_MAX
          ),
        },
      },
      signal
    );
    return updated.documentUpdate.success;
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    logOpsEvent(
      "widget.ticket.report_unsaved",
      { conversationId: ids.conversationId },
      console.warn
    );
    return false;
  }
}

/** A ticket linked to a support chat, with what kind of work it holds. */
export interface LinkedTicket {
  identifier: string;
  kind: TicketKind;
  stateType: string;
  url: string;
}

/**
 * The independent work a chat can hold: an engineering or support case, a
 * refund in billing's queue, and feedback on a Foreman reply. A chat with a
 * bug and a refund gets one of each, never one hiding the other.
 */
export type TicketKind = "case" | "feedback" | "refund";

/** REFUND_TICKET's project and label, as Linear returns them on an issue. */
export const SUPPORT_PROJECT_ID = "4534deb2-6bbc-4e30-ad38-48963f414d14";
export const REFUND_LABEL_ID = "9120e30d-e188-4972-940b-20005b7f6d03";
/** The Acquisity Chat Widget project, where reports on Foreman's replies go. */
export const CHAT_WIDGET_PROJECT_ID = "84ab288a-6a7b-4316-ab6f-f67809a40211";

export const ticketKind = (issue: {
  labels: { nodes: { id: string }[] };
  project: { id: string } | null;
}): TicketKind => {
  if (issue.project?.id === CHAT_WIDGET_PROJECT_ID) {
    return "feedback";
  }
  return issue.project?.id === SUPPORT_PROJECT_ID &&
    issue.labels.nodes.some(({ id }) => id === REFUND_LABEL_ID)
    ? "refund"
    : "case";
};

const LINKED = `query SupportChatTickets($url: String!) {
  attachmentsForURL(url: $url, first: 50) {
    nodes { title url issue { identifier url state { type } project { id } labels { nodes { id } } } }
  }
}`;

interface LinkedResponse {
  attachmentsForURL: {
    nodes: {
      title: string;
      url: string;
      issue: {
        identifier: string;
        labels: { nodes: { id: string }[] };
        project: { id: string } | null;
        state: { type: string };
        url: string;
      } | null;
    }[];
  };
}

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
    return [
      {
        identifier: issue.identifier,
        kind: ticketKind(issue),
        stateType: issue.state.type,
        url: issue.url,
      },
    ];
  });
}
