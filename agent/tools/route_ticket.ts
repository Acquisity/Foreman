import { defineTool } from "eve/tools";
import { z } from "zod";
import { linearAuth } from "#lib/constants.js";
import { denyUnattendedWrites } from "#lib/github/approval.js";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import { routeTicket } from "#lib/linear-api.js";

const identifier = z.string().trim().regex(LINEAR_ISSUE_ID_PATTERN);
const name = z.string().trim().min(1).max(120);

export default defineTool({
  approval: denyUnattendedWrites("Linear"),
  description:
    "Apply final routing decisions to a Linear ticket in one write: state, priority, labels to add, project, assignee, parent, and duplicate relation, then read it back. " +
    "Labels are added to the ones already on the ticket, never replaced; an unknown label name fails before any write and lists the valid names. " +
    "Names are resolved for you: state by name within the ticket's team, project by name, assignee by name or email. " +
    "For a duplicate pass duplicateOf and inheritAssigneeFrom with the same master; an explicit assignee wins over an inherited one. " +
    "links attach urls as resources on the ticket. Use the returned projectId for memory recording.",
  async execute(input, ctx) {
    try {
      const { token } = await ctx.getToken(linearAuth);
      const ticket = await routeTicket(token, input, {
        signal: ctx.abortSignal,
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
    assignee: name.optional().describe("User name or email."),
    duplicateOf: identifier
      .optional()
      .describe("Mark this ticket a duplicate of that issue."),
    inheritAssigneeFrom: identifier
      .optional()
      .describe("Take the assignee from this issue (a master or parent)."),
    issue: identifier.describe("The ticket to route, such as ENG-123."),
    links: z
      .array(z.object({ title: name, url: z.string().url().max(2000) }))
      .max(5)
      .optional(),
    parent: identifier.optional().describe("Parent this ticket to that issue."),
    priority: z
      .number()
      .int()
      .min(0)
      .max(4)
      .optional()
      .describe("1 Urgent, 2 High, 3 Medium, 4 Low, 0 none."),
    project: name.optional().describe("Project name."),
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
  }),
});
