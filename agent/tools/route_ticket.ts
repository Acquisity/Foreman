import { defineTool } from "eve/tools";
import { z } from "zod";
import { executorClient } from "#lib/executor/client.js";
import { questionsOnlyPolicy } from "#lib/github/approval.js";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import { masterCreatedAfter, routeTicket } from "#lib/linear-api.js";
import { masterWindow } from "#lib/master-window.js";
import { logOpsEvent } from "#lib/ops-log.js";
import {
  criticRounds,
  duplicateNeedsMaster,
  routeDecisionEvent,
  routeRefusal,
  triageDecisions,
} from "#lib/triage-log.js";
import { isStatusFollowUp } from "#lib/trust.js";

const identifier = z.string().trim().regex(LINEAR_ISSUE_ID_PATTERN);
const name = z.string().trim().min(1).max(120);

export default defineTool({
  approval: questionsOnlyPolicy,
  description:
    "Apply final routing decisions to a Linear ticket in one write: state, priority, labels to add, project, assignee, parent, and duplicate relation, then read it back. " +
    "Labels are added to the ones already on the ticket, never replaced, and removeLabels takes named ones off; an unknown label name to add fails before any write and lists the valid names. " +
    "Names are resolved for you: state by name within the ticket's team and project by name. The assignee must be a person in the owner map, given by name; any other name fails before any write. A developer takes a ticket only when it is labelled Bug, or Feature Request and Approved, counting the labels being added; the one exception is James holding a Feature Request with Needs approval while he decides it; support owners are not gated. A label change that would leave the current developer holder outside that rule fails before any write unless it also names a new assignee or passes releaseDeveloper. " +
    "For a duplicate pass duplicateOf and inheritAssigneeFrom with the same match; when it has an assignee it is inherited, otherwise assignee (the area owner) is used as the fallback. " +
    "A duplicate is parented under its master for you: a match that is not a customer report is the master, and a report's parent is its master. A parent that differs fails before any write. A master past the master search's recency cutoff is not eligible. A Bug duplicate (by decision or Bug label) with no eligible master fails before any write: make the master through engineering-handoff, parent the match under it (or pass the new master as parent), then call again. A parent held outside the owner map fails before any write. " +
    "The duplicate relation is written before the update, because Linear will not move a ticket to Duplicate without it; when the relation fails nothing is written. " +
    "links attach urls as resources on the ticket. Use the returned projectId for memory recording. " +
    "routed true with warnings means the ticket was updated but a link or the read-back after it failed; read the warning before retrying only that part.",
  async execute(input, ctx) {
    const refusal = routeRefusal(
      triageDecisions.get(),
      criticRounds.get(),
      input,
      { statusRequest: isStatusFollowUp(ctx.session.auth.current) }
    );
    if (refusal) {
      return { error: refusal, routed: false as const };
    }
    try {
      const mastersWindow = input.duplicateOf
        ? await masterWindow(ctx.session.auth)
        : { windowed: false };
      const ticket = await routeTicket(input, {
        client: executorClient(ctx),
        masterRequired: duplicateNeedsMaster(
          triageDecisions.get(),
          input.issue
        ),
        mastersCreatedAfter: masterCreatedAfter(
          mastersWindow.windowed,
          mastersWindow.now
        ),
        signal: ctx.abortSignal,
      });
      logOpsEvent("triage.decision", {
        ...routeDecisionEvent(triageDecisions.get(), {
          ...input,
          duplicateOf: ticket.duplicateOf ?? undefined,
        }),
        sessionId: ctx.session.id,
      });
      return { routed: true as const, ...ticket };
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return {
        error: error instanceof Error ? error.message : "Routing failed.",
        routed: false as const,
      };
    }
  },
  inputSchema: z.object({
    addLabels: z
      .array(name)
      .max(10)
      .optional()
      .describe("Label names to add; existing labels are kept."),
    assignee: name
      .optional()
      .describe(
        "An owner-map person by name; with inheritAssigneeFrom, the fallback for an unassigned source or one held by someone outside the map."
      ),
    duplicateOf: identifier
      .optional()
      .describe("Mark this ticket a duplicate of that issue."),
    inheritAssigneeFrom: identifier
      .optional()
      .describe(
        "Take the assignee from this issue (a master or parent) when it has one."
      ),
    issue: identifier.describe("The ticket to route, such as ENG-123."),
    links: z
      .array(z.object({ title: name, url: z.string().url().max(2000) }))
      .max(5)
      .optional(),
    parent: identifier
      .optional()
      .describe(
        "Parent this ticket to that issue. For a duplicate it is set to the match's master for you."
      ),
    priority: z
      .number()
      .int()
      .min(0)
      .max(4)
      .optional()
      .describe("1 Urgent, 2 High, 3 Medium, 4 Low, 0 none."),
    project: name.optional().describe("Project name."),
    releaseDeveloper: z
      .boolean()
      .optional()
      .describe(
        "Unassign the ticket when a developer holds it and nobody new is assigned; James and support owners are kept."
      ),
    removeLabels: z
      .array(name)
      .max(10)
      .optional()
      .describe("Label names to take off; a name the ticket lacks is ignored."),
    state: name
      .optional()
      .describe("Workflow state name in the ticket's team."),
  }),
  outputSchema: z.object({
    assignee: z.string().nullable().optional(),
    error: z.string().optional(),
    identifier: z.string().optional(),
    labels: z.array(z.string()).optional(),
    parentIdentifier: z.string().nullable().optional(),
    priority: z.number().optional(),
    projectId: z.string().nullable().optional(),
    projectName: z.string().nullable().optional(),
    routed: z.boolean(),
    state: z.string().optional(),
    url: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  }),
});
