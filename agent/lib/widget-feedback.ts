import {
  callLinearGraphQL,
  type LinearApiOptions,
  type LinearChannelCredentials,
} from "eve/channels/linear";
import {
  REPORT_WAITS_MS,
  SUPPORT_REPORT_TITLE,
  WIDGET_FEEDBACK_PROJECT_ID,
} from "./widget-support-report.js";

export interface WidgetFeedbackMarker {
  /** When the report was made (ISO); older tickets predate it. */
  at: string | null;
  conversation: string;
  message: string | null;
  /** Sentry replay id; older tickets predate it. */
  replay: string | null;
  run: string | null;
}

const MARKER_PATTERN =
  /(?:^|\n)<!-- chat-widget-feedback conversation=([\w-]{1,128}) message=([\w-]{1,128}) run=([\w-]{1,128})(?: replay=([\w-]{1,128}))?(?: at=([\w:.+-]{1,40}))? -->\s*$/u;

/**
 * Reads the machine line the widget ends every feedback ticket with. Only the
 * trailing line counts, so a quoted copy inside the transcript cannot stand
 * in for it; `none` means the ticket names no reply or run.
 */
export function parseWidgetFeedbackMarker(
  description: string
): WidgetFeedbackMarker | null {
  const match = MARKER_PATTERN.exec(description.slice(-1024));
  const [, conversation, message, run, replay, at] = match ?? [];
  if (!conversation || conversation === "none") {
    return null;
  }
  const orNull = (value: string | undefined) =>
    value && value !== "none" ? value : null;
  return {
    // A time that does not parse would point the log read at the wrong window.
    at:
      orNull(at) && !Number.isNaN(Date.parse(at as string))
        ? (at as string)
        : null,
    conversation,
    message: orNull(message),
    replay: orNull(replay),
    run: orNull(run),
  };
}

/** What a widget-feedback session is told before the model runs. */
export function widgetFeedbackRoute(
  marker: WidgetFeedbackMarker | null
): string {
  const ids = marker
    ? `The ticket's machine line names conversation ${marker.conversation}, message ${marker.message ?? "none"}, run ${marker.run ?? "none"}, Sentry replay ${marker.replay ?? "none"}, reported at ${marker.at ?? "unknown"}.`
    : "The ticket's machine line is missing or malformed: take the conversation, reply, and run from the Conversation section (in the ticket's Support report document, or the description on older tickets), and say in the comment that the line was missing.";
  return `This issue is chat widget feedback filed into the Acquisity Chat Widget project. Load the widget-feedback skill and follow it instead of triage: diagnose why the widget answered as it did and post exactly one comment on this ticket. Change nothing else. The report, transcript and browser capture are in the ticket's Support report document; older tickets have them in the description instead. ${ids}`;
}

const ISSUE_QUERY = `query WidgetFeedbackIssue($id: String!) {
  issue(id: $id) {
    description
    project { id }
    documents(first: 1, filter: { title: { eq: "${SUPPORT_REPORT_TITLE}" } }) { nodes { title content } }
  }
}`;

interface IssueResponse {
  issue: {
    description: string | null;
    documents: { nodes: { content: string | null; title: string }[] };
    project: { id: string } | null;
  } | null;
}

/**
 * The widget-feedback route for an issue in the widget project, or null for
 * every other issue. The session event carries no project, so it is read.
 */
export async function widgetFeedbackContext(
  issueId: string,
  credentials: LinearChannelCredentials,
  api?: LinearApiOptions,
  waits: number[] = REPORT_WAITS_MS
): Promise<string | null> {
  const read = async () =>
    (
      await callLinearGraphQL<IssueResponse>({
        api,
        credentials,
        query: ISSUE_QUERY,
        queryName: "WidgetFeedbackIssue",
        variables: { id: issueId },
      })
    ).issue;
  let issue = await read();
  if (issue?.project?.id !== WIDGET_FEEDBACK_PROJECT_ID) {
    return null;
  }
  // A customer's report is delegated before its Support report lands; a
  // teammate's, and an older one, carries its line in the description.
  for (const ms of waits) {
    if (
      issue?.documents.nodes.length ||
      parseWidgetFeedbackMarker(issue?.description ?? "")
    ) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: each wait gives the report time to land.
    await new Promise((resolve) => setTimeout(resolve, ms));
    issue = (await read()) ?? issue;
  }
  // Reports filed since ENG-21100 keep the line at the end of their Support
  // report document; older ones end their description with it.
  const report = issue?.documents.nodes.find(
    (document) => document.title === SUPPORT_REPORT_TITLE
  );
  return widgetFeedbackRoute(
    parseWidgetFeedbackMarker(report?.content ?? "") ??
      parseWidgetFeedbackMarker(issue?.description ?? "")
  );
}
