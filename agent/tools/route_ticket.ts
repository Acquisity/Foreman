import { callLinearGraphQL } from "eve/channels/linear";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { linearAuth } from "#lib/constants.js";
import { executorClient } from "#lib/executor/client.js";
import { questionsOnlyPolicy } from "#lib/github/approval.js";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import { isDuplicateState, recordJoin } from "#lib/known-issue-gate.js";
import { masterCreatedAfter } from "#lib/linear-api.js";
import { masterWindow } from "#lib/master-window.js";
import { logOpsEvent } from "#lib/ops-log.js";
import {
  keepChatsOnCase,
  type LinearRead,
  RouteGateError,
  reopenRefusal,
  supportChatsOf,
} from "#lib/route-gates.js";
import { routeTicket } from "#lib/route-ticket.js";
import {
  criticRounds,
  routeDecisionEvent,
  routeRefusal,
  triageDecisions,
} from "#lib/triage-log.js";
import { isTriageReplay } from "#lib/triage-replay/mode.js";
import { isStatusFollowUp } from "#lib/trust.js";

const identifier = z.string().trim().regex(LINEAR_ISSUE_ID_PATTERN);
const LINEAR_TIMEOUT_MS = 15_000;
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

/** The report's Support chat links before a Duplicate join (none for any other route), or null when they could not be read. */
const chatsBeforeJoin = async (
  input: { duplicateOf?: string; issue: string; state?: string },
  linear: LinearRead
): Promise<Awaited<ReturnType<typeof supportChatsOf>> | null> => {
  if (
    !(input.duplicateOf && isDuplicateState(input.state)) ||
    isTriageReplay()
  ) {
    return [];
  }
  return await supportChatsOf(input.issue, linear).catch(() => null);
};

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
    "The fixy label is reserved: only hand_to_fixy adds it and only a person removes it. On a ticket carrying the fixy label, Fixy owns state and assignee: a call that sets either fails before any write. A Done or Canceled ticket from an Asks channel is never moved back to an open state; a move to another closed state still works. " +
    "routed true with warnings means the ticket was updated but a link or the read-back after it failed; read the warning before retrying only that part.",
  async execute(input, ctx) {
    // hand_to_fixy reads whether a join to a known issue was tried.
    const joined = <T extends { error?: string; grouping?: string | null }>(
      result: T
    ): T => {
      recordJoin(input, result);
      return result;
    };
    const refusal = routeRefusal(
      triageDecisions.get(),
      criticRounds.get(),
      input,
      { statusRequest: isStatusFollowUp(ctx.session.auth.current) }
    );
    if (refusal) {
      return joined({ error: refusal, routed: false as const });
    }
    // Not through Executor: its RouteIssue read has no state type or attachments, and it has no attachment delete.
    const linear: LinearRead = async (query, queryName, variables) => {
      const { token } = await ctx.getToken(linearAuth);
      const signal = AbortSignal.any([
        ctx.abortSignal,
        AbortSignal.timeout(LINEAR_TIMEOUT_MS),
      ]);
      return await callLinearGraphQL({
        api: { fetch: (url, init) => fetch(url, { ...init, signal }) },
        credentials: { accessToken: token },
        query,
        queryName,
        variables,
      });
    };
    if (input.state !== undefined && !isTriageReplay()) {
      const reopen = await reopenRefusal(input.issue, input.state, linear);
      if (reopen) {
        ctx.abortSignal.throwIfAborted();
        logOpsEvent("triage.route_refused", {
          code: reopen.code,
          issue: input.issue,
          sessionId: ctx.session.id,
        });
        return joined({ error: reopen.reason, routed: false as const });
      }
    }
    // A Duplicate join moves the case's Support chat link onto the match; read it first to put it back.
    const chats = await chatsBeforeJoin(input, linear);
    if (chats === null) {
      ctx.abortSignal.throwIfAborted();
      return joined({
        error: `Could not read ${input.issue}'s Support chat links, so the join was not written. Call route_ticket again.`,
        routed: false as const,
      });
    }
    // Runs after a failed route too: the relation alone can move the link.
    const keepChats = () =>
      input.duplicateOf && chats.length > 0
        ? keepChatsOnCase(input.issue, input.duplicateOf, chats, linear)
        : Promise.resolve(null);
    try {
      const mastersWindow = picksMaster(input)
        ? await masterWindow(ctx.session.auth)
        : { windowed: false };
      const ticket = await routeTicket(input, {
        // A recorded Bug decision may clear a stale Feature Request label.
        bugDecided:
          triageDecisions.get()[input.issue]?.classification === "Bug",
        client: executorClient(ctx),
        mastersCreatedAfter: masterCreatedAfter(
          mastersWindow.windowed,
          mastersWindow.now
        ),
        signal: ctx.abortSignal,
      });
      const lost = await keepChats();
      if (lost) {
        ticket.warnings.push(lost);
      }
      logOpsEvent("triage.decision", {
        ...routeDecisionEvent(triageDecisions.get(), {
          ...input,
          duplicateOf: ticket.duplicateOf ?? undefined,
        }),
        sessionId: ctx.session.id,
      });
      return joined({ routed: true as const, ...ticket });
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      const lost = await keepChats();
      if (error instanceof RouteGateError) {
        logOpsEvent("triage.route_refused", {
          code: error.code,
          issue: input.issue,
          sessionId: ctx.session.id,
        });
      }
      const message =
        error instanceof Error ? error.message : "Routing failed.";
      return joined({
        error: lost ? `${message} ${lost}` : message,
        routed: false as const,
      });
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
