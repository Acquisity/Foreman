import {
  callLinearGraphQL,
  type LinearApiOptions,
  type LinearChannelCredentials,
} from "eve/channels/linear";

/** Linear project the Acquisity chat widget files its feedback tickets into. */
export const WIDGET_FEEDBACK_PROJECT_ID =
  "84ab288a-6a7b-4316-ab6f-f67809a40211";

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
  /<!-- chat-widget-feedback conversation=([\w-]{1,128}) message=([\w-]{1,128}) run=([\w-]{1,128})(?: replay=([\w-]{1,128}))?(?: at=([\w:.+-]{1,40}))? -->\s*$/u;

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
    at: orNull(at),
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
    : "The ticket's machine line is missing or malformed: take the conversation, reply, and run from the Conversation section, and say in the comment that the line was missing.";
  return `This issue is chat widget feedback filed into the Acquisity Chat Widget project. Load the widget-feedback skill and follow it instead of triage: diagnose why the widget answered as it did and post exactly one comment on this ticket. Change nothing else. ${ids}`;
}

const ISSUE_QUERY = `query WidgetFeedbackIssue($id: String!) {
  issue(id: $id) { description project { id } }
}`;

interface IssueResponse {
  issue: { description: string | null; project: { id: string } | null } | null;
}

/**
 * The widget-feedback route for an issue in the widget project, or null for
 * every other issue. The session event carries no project, so it is read.
 */
export async function widgetFeedbackContext(
  issueId: string,
  credentials: LinearChannelCredentials,
  api?: LinearApiOptions
): Promise<string | null> {
  const { issue } = await callLinearGraphQL<IssueResponse>({
    api,
    credentials,
    query: ISSUE_QUERY,
    queryName: "WidgetFeedbackIssue",
    variables: { id: issueId },
  });
  if (issue?.project?.id !== WIDGET_FEEDBACK_PROJECT_ID) {
    return null;
  }
  return widgetFeedbackRoute(
    parseWidgetFeedbackMarker(issue.description ?? "")
  );
}
