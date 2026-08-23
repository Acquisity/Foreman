// Slack channel IDs: an uppercase letter class then base-32-ish characters.
// Anything else in the env list is a typo (a channel name, a quoted value),
// and silently keeping it would leave the gate off for the channel it was
// meant to cover, so it is dropped loudly instead.
const CHANNEL_ID_PATTERN = /^[CGD][A-Z0-9]{7,}$/u;

export interface SlackIntakeWorkflow {
  mode: "existing-linear-issue" | "new-linear-issue";
  skills: readonly string[];
}

const PRODUCT_TRIAGE_WORKFLOW: SlackIntakeWorkflow = {
  mode: "existing-linear-issue",
  skills: ["triage-investigate", "clarify-with-requester", "slack-wording"],
};

const BILLING_TRIAGE_WORKFLOW: SlackIntakeWorkflow = {
  mode: "existing-linear-issue",
  skills: ["billing-triage", "clarify-with-requester", "slack-wording"],
};

const INTERCOM_INTAKE_WORKFLOW: SlackIntakeWorkflow = {
  mode: "new-linear-issue",
  skills: [],
};

export const SLACK_INTAKE_WORKFLOWS: Readonly<
  Record<string, SlackIntakeWorkflow>
> = {
  C0BBPVC3N2X: PRODUCT_TRIAGE_WORKFLOW,
  C0BC011NAQL: BILLING_TRIAGE_WORKFLOW,
  C0BCV1WBR42: INTERCOM_INTAKE_WORKFLOW,
  C0BLFDUN6Q7: PRODUCT_TRIAGE_WORKFLOW,
  C0BNCL031AQ: INTERCOM_INTAKE_WORKFLOW,
};

const INTAKE_ONLY_BOUNDARY = [
  "This message came from a Slack channel that is intake-only. You may answer questions, investigate, clarify with the requester, and create or update Linear records.",
  "Do not implement a fix or make local code changes. Do not commit, push a branch, open a pull request, or start the factory implementation pipeline. Push and pull-request creation are denied independently of these instructions.",
].join("\n\n");

const GENERIC_NEW_ISSUE_TASK = [
  "Use the generic new-issue workflow. This channel has no dedicated channel skill yet. Do not substitute triage-investigate; Intercom investigation needs its own future procedure.",
  "Investigate the request using the available evidence. Create exactly one unassigned Linear issue containing the request and your findings. Answer in the Slack thread, then stop before implementation.",
].join("\n\n");

const existingIssueTask = (skills: readonly string[]): string =>
  [
    `Use the existing-issue Linear workflow. Before investigating, load every required skill for this channel: ${skills.join(", ")}.`,
    "Identify exactly one existing Linear issue from the Slack thread context and treat it as the source of truth. Investigate and update that issue according to the loaded procedures.",
    "Never create a duplicate Linear issue. If the thread does not identify exactly one issue, ask the requester for its Linear link or identifier, then stop.",
    "Answer in the Slack thread using slack-wording, then stop.",
  ].join("\n\n");

export function resolveSlackIntakeWorkflow(
  channelId: string
): SlackIntakeWorkflow | undefined {
  return SLACK_INTAKE_WORKFLOWS[channelId];
}

export function slackIntakeContext(channelId: string): string {
  const workflow = resolveSlackIntakeWorkflow(channelId);
  const task =
    workflow?.mode === "existing-linear-issue"
      ? existingIssueTask(workflow.skills)
      : GENERIC_NEW_ISSUE_TASK;
  return [INTAKE_ONLY_BOUNDARY, task].join("\n\n");
}

// Parses a comma-separated list of Slack channel IDs into a Set, trimming
// whitespace and dropping empty entries. Pure so tests can import it without
// triggering the env reads in constants.ts.
export function parseIntakeOnlyChannels(raw: string | undefined): Set<string> {
  const channels = new Set<string>();
  if (raw === undefined) {
    return channels;
  }
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim().toUpperCase();
    if (trimmed === "") {
      continue;
    }
    if (CHANNEL_ID_PATTERN.test(trimmed)) {
      channels.add(trimmed);
    } else {
      console.warn(
        `SLACK_INTAKE_ONLY_CHANNELS: ignoring "${trimmed}", not a Slack channel ID.`
      );
    }
  }
  return channels;
}
