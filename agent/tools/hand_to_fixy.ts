import { callLinearGraphQL } from "eve/channels/linear";
import type { SessionAuthContext } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { linearAuth } from "#lib/constants.js";
import {
  fixyHandoffCommentId,
  isFixyTriageIssue,
  isFixyTriageTeam,
  parseFixyHandoff,
  renderFixyHandoff,
  resolveReportedAt,
  TICKET_CREATED,
} from "#lib/fixy-handoff.js";
import {
  isQuestionsOnlySession,
  questionsOnlyPolicy,
} from "#lib/github/approval.js";
import { LINEAR_ISSUE_ID_PATTERN } from "#lib/investigation-memory/scope.js";
import { logOpsEvent } from "#lib/ops-log.js";
import { isTriageReplay } from "#lib/triage-replay/mode.js";

const LINEAR_TIMEOUT_MS = 15_000;
const BUG_LABEL = "Bug";

const ISSUE_QUERY = `query FixyHandoffIssue($id: String!) {
  issue(id: $id) {
    id identifier createdAt
    team { id key }
    labels(first: 100) { nodes { id name } }
    attachments(first: 50) { nodes { title url } }
    comments(first: 100) { nodes { id body } }
  }
}`;
const LABEL_QUERY = `query FixyBugLabel($teamId: ID!, $name: String!) {
  issueLabels(first: 10, filter: { and: [{ name: { eq: $name } }, { or: [{ team: { id: { eq: $teamId } } }, { team: { null: true } }] }] }) {
    nodes { id name team { id } }
  }
}`;
const COMMENT_CREATE = `mutation FixyHandoffCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id } }
}`;
const COMMENT_UPDATE = `mutation FixyHandoffUpdate($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) { success }
}`;
const LABEL_ADD = `mutation FixyHandoffLabel($id: String!, $labelId: String!) {
  issueAddLabel(id: $id, labelId: $labelId) { success }
}`;

interface IssueRead {
  issue: {
    attachments: { nodes: { title: string; url: string }[] };
    comments: { nodes: { body: string; id: string }[] };
    createdAt: string;
    id: string;
    identifier: string;
    labels: { nodes: { id: string; name: string }[] };
    team: { id: string; key: string };
  } | null;
}

/** One Linear GraphQL call with Foreman's own app token. */
export type LinearCall = <T>(
  query: string,
  queryName: string,
  variables: Record<string, string | Record<string, string>>
) => Promise<T>;

export interface HandoffSession {
  auth: {
    current: SessionAuthContext | null;
    initiator: SessionAuthContext | null;
  };
  id: string;
  parent?: unknown;
}

const WORKSPACE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const handToFixyInputSchema = z
  .object({
    expected: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("What the requester expected to happen, one line."),
    issue: z
      .string()
      .trim()
      .regex(LINEAR_ISSUE_ID_PATTERN)
      .describe("The report ticket, such as SAN-145."),
    notes: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "One line for Fixy, such as a known issue route_ticket refused to join."
      ),
    reportedAt: z
      .string()
      .trim()
      .max(40)
      .refine((value) => Number.isFinite(Date.parse(value)))
      .optional()
      .describe(
        "When the requester first reported it, ISO 8601. Used only when the ticket has no 'Ask from' Slack link."
      ),
    reportedAtSource: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Where reportedAt came from, such as 'Intercom first message'."
      ),
    stepsToReproduce: z
      .array(z.string().trim().min(1).max(300))
      .min(1)
      .max(10)
      .describe("Short steps a person could follow to see the problem."),
    whatHappened: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("What went wrong, one line."),
    workspaceId: z
      .string()
      .trim()
      .regex(WORKSPACE_ID)
      .optional()
      .describe("The workspace (organization) id the report is about."),
    workspaceUnknown: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Why the workspace could not be found, when it could not."),
  })
  .refine(
    (input) => Boolean(input.workspaceId) !== Boolean(input.workspaceUnknown),
    { message: "Give exactly one of workspaceId and workspaceUnknown." }
  )
  .refine((input) => !input.reportedAt || Boolean(input.reportedAtSource), {
    message: "reportedAt needs reportedAtSource.",
  });

export type HandToFixyInput = z.infer<typeof handToFixyInputSchema>;

export interface HandToFixyResult {
  alreadyHandedOff: boolean;
  commentId: string | null;
  issue: string;
  labelAdded: boolean;
  reason?: string;
  reportedAt: string | null;
  reportedAtSource: string | null;
  success: boolean;
  warnings: string[];
}

const refusal = (
  issue: string,
  reason: string,
  done: Partial<HandToFixyResult> = {}
): HandToFixyResult => ({
  alreadyHandedOff: false,
  commentId: null,
  issue,
  labelAdded: false,
  reportedAt: null,
  reportedAtSource: null,
  warnings: [],
  ...done,
  reason,
  success: false,
});

/** Why this session may not hand off at all, or null. */
const sessionRefusal = (session: HandoffSession): string | null => {
  if (isQuestionsOnlySession(session.auth)) {
    return "This session is questions-only and writes nothing to Linear.";
  }
  if (session.parent) {
    return "A delegated session cannot hand a report to Fixy; the root session does.";
  }
  if (isTriageReplay()) {
    return "Triage replay does not write to Linear.";
  }
  return null;
};

/**
 * Writes the handoff comment, then the team's Bug label, which starts Fixy's
 * bug run. The comment goes first so Fixy finds it when the run starts, and
 * it is top-level: everything under the requester's thread comment reaches
 * the requester.
 */
export async function handToFixy(
  input: HandToFixyInput,
  session: HandoffSession,
  linear: LinearCall,
  env: NodeJS.ProcessEnv = process.env
): Promise<HandToFixyResult> {
  const { issue } = input;
  if (!isFixyTriageIssue(issue, env)) {
    return refusal(
      issue,
      `${issue} is not on a team in FIXY_TRIAGE_TEAMS, so Fixy would not pick it up. Use the triage-investigate skill instead.`
    );
  }
  const refused = sessionRefusal(session);
  if (refused) {
    return refusal(issue, refused);
  }
  const read = await linear<IssueRead>(ISSUE_QUERY, "FixyHandoffIssue", {
    id: issue,
  });
  const ticket = read.issue;
  if (!ticket) {
    return refusal(issue, `${issue} was not found.`);
  }
  if (!isFixyTriageTeam(ticket.team.key, env)) {
    return refusal(
      issue,
      `${issue} is now on team ${ticket.team.key}, which is not in FIXY_TRIAGE_TEAMS. Use the triage-investigate skill instead.`
    );
  }
  const reported = resolveReportedAt(
    ticket.attachments.nodes,
    { at: input.reportedAt, source: input.reportedAtSource },
    ticket.createdAt
  );
  const body = renderFixyHandoff({
    expected: input.expected,
    notes: input.notes ?? null,
    reportedAt: reported.at,
    reportedAtSource: reported.source,
    steps: input.stepsToReproduce,
    whatHappened: input.whatHappened,
    workspaceId: input.workspaceId?.toLowerCase() ?? null,
    workspaceUnknown: input.workspaceUnknown ?? null,
  });
  const times = { reportedAt: reported.at, reportedAtSource: reported.source };
  // Markup is stripped before writing; a field left empty would not read back.
  if (!parseFixyHandoff(body)) {
    return refusal(
      issue,
      "A field is empty once markup is removed. Write what happened, what was expected, and each step in plain words.",
      times
    );
  }
  const warnings: string[] = [];
  if (reported.source === TICKET_CREATED) {
    warnings.push(
      "No original report time was found, so the handoff uses the ticket's creation time."
    );
  }
  const commentId = fixyHandoffCommentId(ticket.id);
  const existing = ticket.comments.nodes.find(
    (comment) => comment.id === commentId
  );
  const update = async () => {
    const result = await linear<{ commentUpdate: { success: boolean } }>(
      COMMENT_UPDATE,
      "FixyHandoffUpdate",
      { id: commentId, input: { body } }
    );
    if (!result.commentUpdate.success) {
      throw new Error("Linear did not update the handoff comment.");
    }
  };
  if (existing) {
    if (existing.body.trim() !== body) {
      await update();
    }
  } else {
    // Past the first page of comments the handoff may exist unseen; its fixed
    // id makes the create fail, and the update then reaches it.
    let createError: unknown = null;
    const created = await linear<{
      commentCreate: { comment: { id: string } | null; success: boolean };
    }>(COMMENT_CREATE, "FixyHandoffCreate", {
      input: { body, id: commentId, issueId: ticket.id },
    }).catch((error: unknown) => {
      createError = error;
      return null;
    });
    if (!created?.commentCreate.success) {
      await update().catch((error: unknown) => {
        throw createError ?? error;
      });
    }
  }
  const done = { ...times, commentId, warnings };
  if (ticket.labels.nodes.some((label) => label.name === BUG_LABEL)) {
    return {
      ...done,
      alreadyHandedOff: true,
      issue: ticket.identifier,
      labelAdded: false,
      success: true,
    };
  }
  const labels = await linear<{
    issueLabels: {
      nodes: { id: string; name: string; team: { id: string } | null }[];
    };
  }>(LABEL_QUERY, "FixyBugLabel", { name: BUG_LABEL, teamId: ticket.team.id });
  const exact = labels.issueLabels.nodes.filter(
    (label) => label.name === BUG_LABEL
  );
  // The team's own label first; a workspace label serves every team.
  const bug =
    exact.find((label) => label.team?.id === ticket.team.id) ??
    exact.find((label) => !label.team);
  if (!bug) {
    return refusal(
      ticket.identifier,
      `Team ${ticket.team.key} has no label named ${BUG_LABEL}, so Fixy was not started. The handoff comment is written; ask a person to add the label to the team.`,
      done
    );
  }
  const added = await linear<{ issueAddLabel: { success: boolean } }>(
    LABEL_ADD,
    "FixyHandoffLabel",
    { id: ticket.id, labelId: bug.id }
  );
  if (!added.issueAddLabel.success) {
    return refusal(
      ticket.identifier,
      "Linear did not add the Bug label, so Fixy was not started. The handoff comment is written; call this again.",
      done
    );
  }
  return {
    ...done,
    alreadyHandedOff: false,
    issue: ticket.identifier,
    labelAdded: true,
    success: true,
  };
}

const errorReason = (error: unknown) =>
  error instanceof Error ? error.message : "Linear call failed.";

/** The one ops-log outcome for a call: never the reason text, which may carry provider detail. */
export const handoffOutcome = (result: HandToFixyResult): string => {
  if (result.labelAdded) {
    return "handed_off";
  }
  if (result.success) {
    return "updated";
  }
  return result.commentId ? "comment_only" : "refused";
};

export default defineTool({
  approval: questionsOnlyPolicy,
  description:
    "Hand a customer report on a Fixy triage team to Fixy, which reproduces and investigates it. Writes one top-level '## Fixy handoff' comment with the workspace id, the original report time, what happened, what was expected and the steps to reproduce, then adds the team's Bug label, which starts Fixy's run. " +
    "Only for teams in FIXY_TRIAGE_TEAMS; anywhere else it refuses and triage-investigate applies. The report time comes from the ticket's 'Ask from' Slack link when there is one, else from reportedAt, else from ticket creation. " +
    "Calling it again updates the same comment and never adds a second one or another label; alreadyHandedOff true means the Bug label was already on. success false with a reason names what to fix. It posts nothing to the requester.",
  async execute(input, ctx) {
    const linear: LinearCall = async (query, queryName, variables) => {
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
    let result: HandToFixyResult;
    try {
      result = await handToFixy(input, ctx.session, linear);
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      result = refusal(input.issue, errorReason(error));
    }
    logOpsEvent("fixy.handoff", {
      issue: result.issue,
      outcome: handoffOutcome(result),
      sessionId: ctx.session.id,
    });
    return result;
  },
  inputSchema: handToFixyInputSchema,
  outputSchema: z.object({
    alreadyHandedOff: z.boolean(),
    commentId: z.string().nullable(),
    issue: z.string(),
    labelAdded: z.boolean(),
    reason: z.string().optional(),
    reportedAt: z.string().nullable(),
    reportedAtSource: z.string().nullable(),
    success: z.boolean(),
    warnings: z.array(z.string()),
  }),
});
