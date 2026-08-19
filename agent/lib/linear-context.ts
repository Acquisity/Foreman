import type { LinearAgentSessionEvent } from "eve/channels/linear";

/**
 * Task injected when an issue is delegated to the agent in a Linear Agent
 * Session. Unlike the GitHub label intake, this run is attended: a person is
 * watching the Agent Session, so clarification goes back to them through the
 * session rather than posting and stopping.
 */
export const LINEAR_INTAKE_TASK = [
  "This assigned Linear issue activates factory mode. Resolve exactly one repository from an explicit owner/repo or GitHub URL in the signed issue context, then prepare it. If the repository is absent or ambiguous, ask before delegating. Load the factory-pipeline skill and run classifier, root-cause investigator, analyst, implementer, and independent reviewer, then open a normal pull request and stabilize it to readiness.",
  "A person is watching this Agent Session, so when the classifier needs clarification, ask them and wait; report progress as you go.",
].join("\n\n");

/**
 * Builds the dispatch context for a Linear Agent Session event, or null when
 * the event should not dispatch.
 *
 * @remarks
 * Keeps the default created/prompted dispatch: any other action returns null.
 * The requester's name is added as context when Linear provides it, for
 * attribution in progress notes and reports. When an issue is delegated (a
 * `created` event carrying an issue), the factory intake task is also injected
 * so the delegated issue runs the full pipeline; `prompted` continuations in
 * the same session do not re-inject it.
 */
export function buildLinearContext(
  event: LinearAgentSessionEvent
): string[] | null {
  if (event.action !== "created" && event.action !== "prompted") {
    return null;
  }
  const requester = event.agentActivity?.user ?? event.agentSession.creator;
  const context: string[] = [];
  const requesterName = requester?.displayName ?? requester?.name;
  if (requesterName) {
    context.push(`The requesting user is ${requesterName}.`);
  }
  if (event.action === "created" && event.agentSession.issue) {
    context.push(LINEAR_INTAKE_TASK);
  }
  return context;
}
