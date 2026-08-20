import { disableTool } from "eve/tools";

/**
 * Removes eve's built-in `ask_question` tool.
 *
 * @remarks
 * The tool parks the session on a channel-rendered prompt. Slack cannot
 * deliver an answer to one: Vercel Connect forwards Events API events and
 * never interactive payloads, so a button click never reaches the app, and a
 * typed reply only resolves a prompt when its text equals an option id
 * exactly, which the channel's `<slack_message>` envelope defeats. A parked
 * Slack session can still talk but can never call another tool, so the work
 * stops for good.
 *
 * The prompt is model-written, so nothing bounds it to genuine clarification.
 * A question like "Approve pushing this branch?" with Approve and Cancel
 * options reproduces the approval card this repository removed from every
 * authored tool, and options without `allowFreeform: true` is the default
 * shape, which is the unanswerable one. Removing the tool makes that
 * impossible rather than discouraged.
 *
 * Nothing is lost on a message surface. The model asks in its reply and the
 * next message answers it, which is how Slack, Linear, and GitHub threads
 * already work, and how the clarify-with-requester and triage skills are
 * already written.
 */
export default disableTool();
