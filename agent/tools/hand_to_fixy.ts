import { callLinearGraphQL } from "eve/channels/linear";
import type { SessionContext } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { linearAuth } from "#lib/constants.js";
import {
  FIXY_LABEL,
  FIXY_LANES,
  fixyHandoffCommentId,
  isFixyTriageIssue,
  isFixyTriageTeam,
  laneLabel,
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

const ISSUE_QUERY = `query FixyHandoffIssue($id: String!) {
  issue(id: $id) {
    id identifier createdAt
    team { id key }
    labels(first: 100) { nodes { id name } }
    attachments(first: 50) { nodes { title url } }
    comments(first: 100) { nodes { id body } pageInfo { hasNextPage } }
  }
}`;
const COMMENT_QUERY = `query FixyHandoffComment($id: String!) {
  comment(id: $id) { id body }
}`;
const LABEL_QUERY = `query FixyLabels($teamId: ID!, $names: [String!]!) {
  issueLabels(first: 50, filter: { and: [{ name: { in: $names } }, { or: [{ team: { id: { eq: $teamId } } }, { team: { null: true } }] }] }) {
    nodes { id name team { id } }
  }
}`;
const COMMENT_CREATE = `mutation FixyHandoffCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id } }
}`;
const COMMENT_UPDATE = `mutation FixyHandoffUpdate($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) { success }
}`;
const LABELS_ADD = `mutation FixyHandoffLabels($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

interface IssueRead {
  issue: {
    attachments: { nodes: { title: string; url: string }[] };
    comments: {
      nodes: { body: string; id: string }[];
      pageInfo: { hasNextPage: boolean };
    };
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
  variables: Record<
    string,
    string | string[] | Record<string, string | string[]>
  >
) => Promise<T>;

export type HandoffSession = Pick<
  SessionContext["session"],
  "auth" | "id" | "parent"
>;

/** Linear's answer to a lookup by an id that doesn't exist (measured 2 Nov 2026). */
const isNotFound = (error: unknown): boolean => {
  const errors = (error as { body?: { errors?: unknown } } | null)?.body
    ?.errors;
  return (
    Array.isArray(errors) &&
    errors.some((entry: { message?: unknown } | null) =>
      String(entry?.message ?? "").startsWith("Entity not found")
    )
  );
};

const WORKSPACE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const handToFixyInputSchema = z
  .object({
    card: z
      .null()
      .optional()
      .describe("No playbook cards exist yet; leave it out."),
    expected: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe(
        "What the requester expected to happen, one line. For billing, the outcome they want."
      ),
    issue: z
      .string()
      .trim()
      .regex(LINEAR_ISSUE_ID_PATTERN)
      .describe("The report ticket, such as SAN-145."),
    lanes: z
      .array(z.enum(FIXY_LANES))
      .min(1)
      .max(4)
      .refine((lanes) => new Set(lanes).size === lanes.length, {
        message: "Name each lane once.",
      })
      .describe(
        "Every lane the ask carries: billing (money), unblock (a stuck account or record), eng (a fix in the code), question (answered how-to)."
      ),
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
      .max(10)
      .default([])
      .describe(
        "Short steps a person could follow to see the problem. Needed when lanes includes eng."
      ),
    whatHappened: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("What went wrong, one line. For billing, the ask itself."),
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
  })
  .refine(
    (input) =>
      !input.lanes.includes("eng") || input.stepsToReproduce.length > 0,
    { message: "An eng handoff needs stepsToReproduce." }
  );

export type HandToFixyInput = z.infer<typeof handToFixyInputSchema>;

export interface HandToFixyResult {
  alreadyHandedOff: boolean;
  commentId: string | null;
  fixyNotified: boolean;
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
  fixyNotified: false,
  issue,
  labelAdded: false,
  reportedAt: null,
  reportedAtSource: null,
  warnings: [],
  ...done,
  reason,
  success: false,
});

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

const writeHandoff = async (
  linear: LinearCall,
  issueId: string,
  commentId: string,
  body: string,
  existing: { body: string } | null
): Promise<void> => {
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
    // A concurrent call may have created the fixed comment since the read.
    let createError: unknown = null;
    const created = await linear<{
      commentCreate: { comment: { id: string } | null; success: boolean };
    }>(COMMENT_CREATE, "FixyHandoffCreate", {
      input: { body, id: commentId, issueId },
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
};

/**
 * Writes the handoff comment, then the fixy label, which starts Fixy's run,
 * with a `lane:<name>` label for each lane. The comment goes first so Fixy finds it when the run starts, and
 * it is top-level: everything under the requester's thread comment reaches
 * the requester.
 */
export const handToFixy = async (
  input: HandToFixyInput,
  session: HandoffSession,
  linear: LinearCall,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal
): Promise<HandToFixyResult> => {
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
  const commentId = fixyHandoffCommentId(ticket.id);
  const existing =
    ticket.comments.nodes.find((comment) => comment.id === commentId) ??
    (ticket.comments.pageInfo.hasNextPage
      ? (
          await linear<{ comment: { id: string; body: string } | null }>(
            COMMENT_QUERY,
            "FixyHandoffComment",
            { id: commentId }
          ).catch((error: unknown) => {
            // On a first hand-off the comment doesn't exist yet, which Linear
            // answers with an error. Any other failure must not pass for
            // absence, or the update would drop the stored report time.
            if (!isNotFound(error)) {
              throw error;
            }
            return { comment: null };
          })
        ).comment
      : null);
  const previous = existing ? parseFixyHandoff(existing.body) : null;
  const reported = resolveReportedAt(
    ticket.attachments.nodes,
    {
      at: input.reportedAt ?? previous?.reportedAt,
      source: input.reportedAt
        ? input.reportedAtSource
        : previous?.reportedAtSource,
    },
    ticket.createdAt
  );
  const body = renderFixyHandoff({
    expected: input.expected,
    lanes: input.lanes,
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
  await writeHandoff(linear, ticket.id, commentId, body, existing);
  const done = { ...times, commentId, fixyNotified: false, warnings };
  const present = new Set(ticket.labels.nodes.map((label) => label.name));
  // The fixy label is what starts Fixy, so carrying it means handed off.
  const alreadyHandedOff = present.has(FIXY_LABEL);
  const wanted = [FIXY_LABEL, ...input.lanes.map(laneLabel)].filter(
    (name) => !present.has(name)
  );
  const settled = { ...done, alreadyHandedOff, issue: ticket.identifier };
  if (wanted.length === 0) {
    return { ...settled, labelAdded: false, success: true };
  }
  try {
    const labels = await linear<{
      issueLabels: {
        nodes: { id: string; name: string; team: { id: string } | null }[];
      };
    }>(LABEL_QUERY, "FixyLabels", { names: wanted, teamId: ticket.team.id });
    // The team's own label first; a workspace label serves every team.
    const found = wanted.map((name) => {
      const exact = labels.issueLabels.nodes.filter(
        (label) => label.name === name
      );
      return (
        exact.find((label) => label.team?.id === ticket.team.id) ??
        exact.find((label) => !label.team)
      );
    });
    const missing = wanted.filter((_, index) => !found[index]);
    if (missing.length > 0) {
      // Nothing is added, so a lane label never lands without the trigger.
      return refusal(
        ticket.identifier,
        `Team ${ticket.team.key} has no label named ${missing.join(", ")}, so no label was added${alreadyHandedOff ? "" : " and Fixy was not started"}. The handoff comment is written; ask a person to create the label, then call this again.`,
        settled
      );
    }
    const added = await linear<{ issueUpdate: { success: boolean } }>(
      LABELS_ADD,
      "FixyHandoffLabels",
      {
        id: ticket.id,
        input: { addedLabelIds: found.map((label) => label?.id ?? "") },
      }
    );
    if (!added.issueUpdate.success) {
      return refusal(
        ticket.identifier,
        "Linear did not add the labels, so Fixy may not have started. The handoff comment is written; call this again.",
        settled
      );
    }
    return {
      ...settled,
      fixyNotified: !alreadyHandedOff,
      labelAdded: true,
      success: true,
    };
  } catch (error) {
    signal?.throwIfAborted();
    return refusal(
      ticket.identifier,
      "The handoff comment is written, but the labels could not be confirmed. Check the ticket before retrying. " +
        errorReason(error),
      settled
    );
  }
};

const errorReason = (error: unknown) =>
  error instanceof Error ? error.message : "Linear call failed.";

/** The one ops-log outcome for a call: never the reason text, which may carry provider detail. */
export const handoffOutcome = (result: HandToFixyResult): string => {
  if (result.fixyNotified) {
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
    "Hand this session's report ticket on a Fixy triage team to Fixy, which owns its status from then on. Writes one top-level '## Fixy handoff' comment with the workspace id, the original report time, what happened, what was expected, the lanes, the card (always none for now) and any steps to reproduce, then adds the fixy label, which starts Fixy's run, and a lane:<name> label for each lane. " +
    "Only for teams in FIXY_TRIAGE_TEAMS; anywhere else it refuses and triage-investigate applies. The report time comes from the ticket's 'Ask from' Slack link when there is one, else from reportedAt, else from the existing handoff, else from ticket creation. " +
    "Calling it again updates the same comment and never adds a second one; it adds only lane labels the ticket lacks. alreadyHandedOff true means the fixy label was already on and fixyNotified false means no run was notified. success false with a reason names what to fix, including any label missing from Linear. It posts nothing to the requester.",
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
      result = await handToFixy(
        input,
        ctx.session,
        linear,
        process.env,
        ctx.abortSignal
      );
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
    fixyNotified: z.boolean(),
    issue: z.string(),
    labelAdded: z.boolean(),
    reason: z.string().optional(),
    reportedAt: z.string().nullable(),
    reportedAtSource: z.string().nullable(),
    success: z.boolean(),
    warnings: z.array(z.string()),
  }),
});
