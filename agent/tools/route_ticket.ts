import { defineTool } from "eve/tools";
import { z } from "zod";
import { executorClient } from "#lib/executor/client.js";
import { questionsOnlyPolicy } from "#lib/github/approval.js";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import { masterCreatedAfter } from "#lib/linear-api.js";
import { masterWindow } from "#lib/master-window.js";
import { logOpsEvent } from "#lib/ops-log.js";
import { routeTicket } from "#lib/route-ticket.js";
import {
  criticRounds,
  routeDecisionEvent,
  routeRefusal,
  triageDecisions,
} from "#lib/triage-log.js";
import { isStatusFollowUp } from "#lib/trust.js";

const identifier = z.string().trim().regex(LINEAR_ISSUE_ID_PATTERN);
const name = z.string().trim().min(1).max(120);

/**
 * Whether this call chooses a master, so the session's master cutoff applies:
 * a match to join, or a parent-only Duplicate, as on the retry writeUpdate
 * recommends after the relation landed.
 */
const picksMaster = (input: {
  duplicateOf?: string;
  parent?: string;
  relatedTo?: string;
  state?: string;
}): boolean =>
  Boolean(
    input.duplicateOf ||
      input.relatedTo ||
      (input.parent && input.state?.trim().toLowerCase() === "duplicate")
  );

export default defineTool({
  approval: questionsOnlyPolicy,
  description:
    "Apply final routing decisions to a Linear ticket in one write: state, priority, labels to add, project, assignee, parent, and duplicate relation, then read it back. " +
    "Labels are added to the ones already on the ticket, never replaced, and removeLabels takes named ones off; an unknown label name to add fails before any write and lists the valid names. " +
    "Names are resolved for you: state by name within the ticket's team and project by name. The assignee must be a person in the owner map, given by name; any other name fails before any write. A developer takes a ticket only when it is labelled Bug, or Feature Request and Approved, counting the labels being added; the one exception is James holding a Feature Request with Needs approval while he decides it; support owners are not gated. A label change that would leave the current developer holder outside that rule fails before any write unless it also names a new assignee or passes releaseDeveloper. " +
    "For a duplicate pass duplicateOf and inheritAssigneeFrom with the same match; when it has an assignee it is inherited, otherwise assignee (the area owner) is used as the fallback. For a report that stays open beside a match (a feature request) pass relatedTo instead. " +
    "A match's report is parented under its open master for you: the match when it is a master (its description has the master template's Regression seam section, or it already parents an issue), else the match's parent when that is one. A parent that differs fails before any write; a parent passed must be an open master the match is already under. A master past the master search's recency cutoff, or one already closed, is not eligible. Duplicate is set only when the report joins that master in the same call and the read-back shows it there. With no eligible master, for every classification, the report is not closed: it is related to the match and labelled Needs grouping, a closing state becomes Backlog held by Aaron Fraga (James Keeble for a feature request) instead of the match's owner, and grouping says needs-grouping; a Bug can still join a master made through engineering-handoff on a later call. Duplicate without duplicateOf needs parent set to an open master. A parent held outside the owner map fails before any write. A Feature Request closes only when the ticket already carries Declined (a person's decision) or Approved; a route that adds Declined itself fails before any write. " +
    "The match's relation is written before the update, because Linear will not move a ticket to Duplicate without it; when the relation fails nothing is written. " +
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
      const mastersWindow = picksMaster(input)
        ? await masterWindow(ctx.session.auth)
        : { windowed: false };
      const ticket = await routeTicket(input, {
        client: executorClient(ctx),
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
    relatedTo: identifier
      .optional()
      .describe(
        "Keep this ticket open and relate it to that match: it joins the match's open master, or waits labelled Needs grouping."
      ),
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
    grouping: z.enum(["joined", "needs-grouping"]).nullable().optional(),
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
