import { callLinearGraphQL } from "eve/channels/linear";
import { z } from "zod";
import { linearAuth } from "./constants.js";
import { executorClient } from "./executor/client.js";
import {
  cancelMigrationTicket,
  createMigrationTicket,
  type ExecutorOutcome,
  type ProviderContext,
} from "./executor/dispatch.js";
import {
  type LinearGraphqlOptions,
  linearGraphql,
  phraseFilter,
} from "./linear-api.js";
import type { LinearResponse } from "./linear-response.js";
import { confirmedIssue } from "./linear-ticket-report.js";
import {
  customerEmailSchema,
  lookupCustomer,
  PRODUCTION_READ_QUERY_ARGS,
} from "./lookup-customer.js";
import {
  filingScope,
  type MigrationTicketScope,
  migrationFiledReport,
  migrationScopeBlock,
  rememberCancellable,
  slackThreadPermalink,
  threadKey,
} from "./migration-ticket-scope.js";
import { logOpsEvent } from "./ops-log.js";
import {
  callPlanetscaleReadQuery,
  parseReadQueryResult,
} from "./planetscale.js";
import { SLACK_ANCHOR_PATTERN } from "./requester-reply.js";
import {
  lookupSlackRequester,
  type SlackRequester,
} from "./slack-requester.js";

const field = (max: number) => z.string().trim().min(1).max(max);
const RECORD_TYPES = ["contact", "company", "deal"] as const;

/**
 * What the model passes. Every field is optional here so a missing one comes
 * back by name, for the model to ask the rep for, instead of as a schema error.
 */
export const migrationTicketInputSchema = z.strictObject({
  affectedUser: z
    .union([z.literal("reporter"), customerEmailSchema])
    .optional()
    .describe(
      "\"reporter\" only when the report shows the requester is the one affected; otherwise the affected user's email. Never the requester's email for a report made for someone else."
    ),
  checked: field(600)
    .optional()
    .describe(
      "One line on what you checked, such as the code or this account's data."
    ),
  classification: z
    .enum(["bug", "worth_improving", "workaround"])
    .optional()
    .describe(
      "bug, worth_improving, or workaround (unblocked now, real fix still needed). Working as intended and couldn't find it never get a ticket."
    ),
  expected: field(1000).optional().describe("What the rep expected to happen."),
  happened: field(2000).optional().describe("What happened instead."),
  impact: field(1000)
    .optional()
    .describe(
      "Who it hurts and how: the rep, the record, and what they lost or cannot do."
    ),
  record: z
    .strictObject({ id: z.uuid(), type: z.enum(RECORD_TYPES) })
    .optional()
    .describe(
      "The CRM record the report is about, by id. It must belong to this channel's workspace."
    ),
  reviewedCandidates: z
    .array(z.string().regex(/^[A-Z]{2,10}-\d{1,7}$/u))
    .max(20)
    .optional()
    .describe(
      "Open tickets the tool listed that you read and found do not cover this report."
    ),
  screenshot: field(1000)
    .optional()
    .describe(
      "What the screenshot shows and where it is, such as attached in this thread. Needed when the problem is visual, unless videoLink is given."
    ),
  searchPhrases: z
    .array(z.string().trim().min(3).max(120))
    .min(2)
    .max(4)
    .optional()
    .describe(
      "Two to four phrasings of the symptom, used to find an open ticket that already covers it."
    ),
  title: field(160).optional().describe("The mechanism, said out loud."),
  tried: field(1000).optional().describe("What the rep tried, step by step."),
  videoLink: z.url().max(500).optional(),
  visual: z
    .boolean()
    .optional()
    .describe("Whether the problem is something seen on screen."),
  when: field(200).optional().describe("When it happened, as the rep said it."),
  where: field(300)
    .optional()
    .describe(
      "The page, tab or button, such as Conversations, Needs reply tab."
    ),
  workaroundGiven: field(600)
    .optional()
    .describe("The workaround you gave in the thread, when you gave one."),
});
export type MigrationTicketInput = z.infer<typeof migrationTicketInputSchema>;

const REQUIRED = [
  "affectedUser",
  "checked",
  "classification",
  "expected",
  "happened",
  "impact",
  "searchPhrases",
  "title",
  "tried",
  "visual",
  "when",
  "where",
] as const;

interface ThreadTicket {
  createdAt: string;
  identifier: string;
  stateType: string;
  url: string;
}

/** An open ticket that may already cover the report, with enough text to judge it. */
export interface Candidate {
  excerpt: string;
  identifier: string;
  state: string;
  title: string;
  url: string;
}

export type MigrationTicketResult =
  | {
      duplicatesLeft?: string[];
      existing: boolean;
      identifier: string;
      threadSynced: boolean;
      url: string;
      warning?: string;
    }
  | { missing: string[]; reason: string }
  | { candidates: Candidate[]; reason: string; truncated: boolean }
  | { error: string };

export interface MigrationTicketDeps {
  cancel: (
    ctx: ProviderContext,
    identifier: string
  ) => Promise<ExecutorOutcome>;
  create: (
    ctx: ProviderContext,
    input: {
      description: string;
      link: { title: string; url: string };
      title: string;
    }
  ) => Promise<ExecutorOutcome>;
  lookupMemberships: (
    email: string,
    ctx: ProviderContext
  ) => Promise<{ found: boolean; orgs: string[]; error?: string }>;
  readRecord: (
    ctx: ProviderContext,
    record: { id: string; type: (typeof RECORD_TYPES)[number] },
    organizationId: string
  ) => Promise<string | null>;
  related: (
    phrases: string[],
    ctx: ProviderContext
  ) => Promise<{ issues: Candidate[]; truncated: boolean }>;
  requester: (userId: string) => Promise<SlackRequester>;
  /** Whether the ticket's Slack thread is connected; null when that could not be read. */
  synced: (ctx: ProviderContext, issue: string) => Promise<boolean | null>;
  syncSlack: (
    ctx: ProviderContext,
    issue: string,
    link: { title?: string; url: string }
  ) => Promise<boolean>;
  thread: (
    scope: MigrationTicketScope,
    ctx: ProviderContext
  ) => Promise<ThreadTicket[]>;
}

/** At most this many candidates are shown, and exactly those must be acknowledged. */
export const MAX_CANDIDATES = 20;
const EXCERPT_CHARS = 600;
// IssueBodies returns one page of this many.
const ISSUE_BODIES_PAGE = 25;

const runRead = (ctx: ProviderContext) => (query: string) =>
  callPlanetscaleReadQuery(ctx, { ...PRODUCTION_READ_QUERY_ARGS, query });

const RECORD_TABLE = {
  company: "crm_company",
  contact: "crm_contact",
  deal: "crm_deal",
} as const;

const SLACK_LINK_MUTATION = `mutation MigrationSlackThread($issueId: String!, $url: String!, $title: String) {
  attachmentLinkSlack(issueId: $issueId, url: $url, title: $title, syncToCommentThread: true) { success }
}`;
const ANCHOR_QUERY = `query MigrationThreadAnchor($id: String!) {
  issue(id: $id) { comments(first: 100) { nodes { body parent { id } } } }
}`;
const FOREMAN_LINEAR_TIMEOUT_MS = 15_000;

/** One call with Foreman's own Linear app token, bounded and cancellable. */
const foremanLinear = async <T>(
  ctx: ProviderContext,
  query: string,
  queryName: string,
  variables: Record<string, string>
): Promise<T> => {
  const { token } = await ctx.getToken(linearAuth);
  const signal = AbortSignal.any([
    ctx.abortSignal,
    AbortSignal.timeout(FOREMAN_LINEAR_TIMEOUT_MS),
  ]);
  return await callLinearGraphQL<T>({
    api: { fetch: (url, init) => fetch(url, { ...init, signal }) },
    credentials: { accessToken: token },
    query,
    queryName,
    variables,
  });
};

const excerpt = (text: string | null) => {
  const flat = (text ?? "").replace(/\s+/gu, " ").trim();
  return flat.length > EXCERPT_CHARS
    ? `${flat.slice(0, EXCERPT_CHARS)}...`
    : flat;
};

/**
 * Open tickets matching any phrasing, with each one's state and a bounded
 * description excerpt from the same read, so the model can judge it without
 * the Linear reads this lane does not have. The read returns one page, so a
 * full page counts as truncated.
 */
export async function readCandidates(
  phrases: string[],
  opts: LinearGraphqlOptions
): Promise<{ issues: Candidate[]; truncated: boolean }> {
  const { issues } = await linearGraphql<LinearResponse<"IssueBodies">>(
    "IssueBodies",
    {
      filter: {
        and: [
          { or: phrases.map(phraseFilter) },
          { state: { type: { nin: ["canceled", "completed"] } } },
        ],
      },
    },
    opts
  );
  return {
    issues: issues.nodes.map((node) => ({
      excerpt: excerpt(node.description),
      identifier: node.identifier,
      state: node.state.name,
      title: node.title,
      url: node.url,
    })),
    truncated: issues.nodes.length >= ISSUE_BODIES_PAGE,
  };
}

/**
 * This thread's live tickets: those not canceled whose description ends with
 * this thread's own server-written scope block. Text that merely mentions the
 * thread key never counts, so a ticket read here is safe to settle.
 */
export async function readThreadTickets(
  scope: MigrationTicketScope,
  opts: LinearGraphqlOptions
): Promise<ThreadTicket[]> {
  const { issues } = await linearGraphql<LinearResponse<"IssueBodies">>(
    "IssueBodies",
    {
      filter: {
        and: [
          phraseFilter(threadKey(scope)),
          { state: { type: { neq: "canceled" } } },
        ],
      },
    },
    opts
  );
  return issues.nodes
    .filter((node) => {
      const filed = migrationFiledReport(node.description);
      return Boolean(
        filed &&
          node.description
            ?.trimEnd()
            .endsWith(migrationScopeBlock(scope, filed.reporter))
      );
    })
    .map((node) => ({
      createdAt: node.createdAt,
      identifier: node.identifier,
      stateType: "live",
      url: node.url,
    }));
}

const defaultDeps: MigrationTicketDeps = {
  cancel: cancelMigrationTicket,
  create: createMigrationTicket,
  async lookupMemberships(email, ctx) {
    const result = await lookupCustomer(email, runRead(ctx));
    if (result.error || (result.truncated && result.memberships.length > 0)) {
      return {
        error: result.error ?? "The membership list was cut off.",
        found: false,
        orgs: [],
      };
    }
    return {
      found: result.found,
      orgs: result.memberships.map((membership) => membership.organizationId),
    };
  },
  async readRecord(ctx, record, organizationId) {
    // Both ids are schema-checked UUIDs, so the literals cannot break out.
    const { rows } = parseReadQueryResult(
      await runRead(ctx)(
        `SELECT name FROM ${RECORD_TABLE[record.type]} WHERE id = '${record.id}' AND organization_id = '${z.uuid().parse(organizationId)}' AND deleted_at IS NULL LIMIT 1`
      )
    );
    const name = (rows[0] as { name?: unknown } | undefined)?.name;
    return typeof name === "string" && name.trim()
      ? name.trim().slice(0, 200)
      : null;
  },
  related: (phrases, ctx) =>
    readCandidates(phrases, {
      client: executorClient(ctx),
      signal: ctx.abortSignal,
    }),
  requester: (userId) => lookupSlackRequester(userId),
  async synced(ctx, issue) {
    try {
      const result = await foremanLinear<{
        issue: {
          comments: { nodes: { body: string; parent: unknown }[] };
        } | null;
      }>(ctx, ANCHOR_QUERY, "MigrationThreadAnchor", { id: issue });
      return (result.issue?.comments.nodes ?? []).some(
        (comment) =>
          !comment.parent && SLACK_ANCHOR_PATTERN.test(comment.body.trim())
      );
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return null;
    }
  },
  async syncSlack(ctx, issue, link) {
    try {
      const result = await foremanLinear<{
        attachmentLinkSlack: { success: boolean };
      }>(ctx, SLACK_LINK_MUTATION, "MigrationSlackThread", {
        issueId: issue,
        url: link.url,
        ...(link.title ? { title: link.title } : {}),
      });
      return result.attachmentLinkSlack.success === true;
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return false;
    }
  },
  thread: (scope, ctx) =>
    readThreadTickets(scope, {
      client: executorClient(ctx),
      signal: ctx.abortSignal,
    }),
};

// A canceled ticket no longer covers the thread; a completed one still does,
// as for a widget conversation.
const live = (ticket: ThreadTicket) => ticket.stateType !== "canceled";

const ticketNumber = (identifier: string) =>
  Number(identifier.slice(identifier.indexOf("-") + 1));

/** The thread's ticket: the oldest live one, so every racing filer agrees. */
const threadWinner = (tickets: ThreadTicket[]): ThreadTicket | undefined =>
  tickets
    .filter(live)
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        ticketNumber(a.identifier) - ticketNumber(b.identifier)
    )[0];

const CLASSIFICATION_LABEL = {
  bug: "Bug",
  workaround: "Workaround given, real fix needed",
  worth_improving: "Worth improving",
} as const;

// Rep-written text is quoted into Markdown; drop control characters other
// than newlines, and keep it from opening a heading of its own.
const CONTROL = /[\p{Cc}\u2028\u2029]/gu;
const HEADING = /^#+/gmu;
const clean = (value: string) =>
  value
    .replace(CONTROL, (char) => (char === "\n" ? "\n" : " "))
    .replace(HEADING, "")
    .trim();

type Complete = MigrationTicketInput &
  Required<Pick<MigrationTicketInput, (typeof REQUIRED)[number]>>;

const missingFields = (input: MigrationTicketInput): string[] => {
  const missing: string[] = REQUIRED.filter((key) => input[key] === undefined);
  if (input.visual === true && !(input.screenshot || input.videoLink)) {
    missing.push("screenshot");
  }
  if (input.classification === "workaround" && !input.workaroundGiven) {
    missing.push("workaroundGiven");
  }
  return missing;
};

/** The form's five-field description, then the server-written Slack scope block. */
export function migrationTicketDescription(
  input: Complete,
  scope: MigrationTicketScope,
  facts: { affectedEmail: string; record: string | null; reporterEmail: string }
): string {
  const whatsWrong = [
    `Outcome: ${CLASSIFICATION_LABEL[input.classification]}`,
    `Who it hurts: ${clean(input.impact)}`,
    `What they tried: ${clean(input.tried)}`,
    `What happened: ${clean(input.happened)}`,
    `What they expected: ${clean(input.expected)}`,
    `Where: ${clean(input.where)}`,
    `When: ${clean(input.when)}`,
    `What Foreman checked: ${clean(input.checked)}`,
    ...(input.workaroundGiven
      ? [`Workaround given: ${clean(input.workaroundGiven)}`]
      : []),
  ].join("\n\n");
  return [
    "#### Customer Email",
    facts.affectedEmail,
    "#### Workspace name",
    scope.workspace.name,
    "#### Workspace ID",
    scope.workspace.id,
    "#### Which lead?",
    facts.record ?? "No record named.",
    "#### What's wrong?",
    whatsWrong,
    "#### Screenshot",
    input.screenshot ? clean(input.screenshot) : "None.",
    "#### Video link",
    input.videoLink ?? "None.",
    migrationScopeBlock(scope, facts.reporterEmail),
  ].join("\n\n");
}

const UNVERIFIED =
  "The workspace check could not run, so nothing was filed. Do not retry automatically; tell the rep you could not file it yet.";

type Refusal = Extract<
  MigrationTicketResult,
  { missing: string[] } | { candidates: Candidate[] } | { error: string }
>;

/**
 * Exactly the candidates shown must be acknowledged, so a long result can
 * always be completed and a stale acknowledgment never files.
 */
async function candidateCheck(
  deps: MigrationTicketDeps,
  ctx: ProviderContext,
  input: Complete
): Promise<Refusal | null> {
  const related = await deps.related(input.searchPhrases, ctx);
  const shown = related.issues.slice(0, MAX_CANDIDATES);
  const reviewed = new Set(input.reviewedCandidates ?? []);
  const acknowledged =
    reviewed.size === shown.length &&
    shown.every((candidate) => reviewed.has(candidate.identifier));
  if (shown.length === 0 || acknowledged) {
    return null;
  }
  const truncated = related.truncated || related.issues.length > MAX_CANDIDATES;
  return {
    candidates: shown,
    reason: `Read these open tickets. If one covers this report, reply with its link and say the team is already working on it, and file nothing. Otherwise call again with exactly these identifiers in reviewedCandidates.${truncated ? " More matched than are shown, so sharper searchPhrases may find a closer match." : ""}`,
    truncated,
  };
}

/** The affected user and named record, each resolved inside the pinned workspace. */
async function workspaceFacts(
  deps: MigrationTicketDeps,
  ctx: ProviderContext,
  scope: MigrationTicketScope,
  input: Complete,
  requesterEmail: string
): Promise<Refusal | { affectedEmail: string; record: string | null }> {
  const affectedEmail =
    input.affectedUser === "reporter" ? requesterEmail : input.affectedUser;
  const membership = await deps.lookupMemberships(affectedEmail, ctx);
  if (membership.error) {
    return { error: UNVERIFIED };
  }
  if (!membership.orgs.includes(scope.workspace.id)) {
    return {
      missing: ["affectedUser"],
      reason: `That user is not a member of ${scope.workspace.name}. Ask the rep for the email of the user it happened to in this workspace.`,
    };
  }
  if (!input.record) {
    return { affectedEmail, record: null };
  }
  const name = await deps.readRecord(ctx, input.record, scope.workspace.id);
  if (!name) {
    return {
      missing: ["record"],
      reason: `No ${input.record.type} with that id is in ${scope.workspace.name}. Ask the rep which record it is, or file without one.`,
    };
  }
  return {
    affectedEmail,
    record: `${clean(name)} (${input.record.type} ${input.record.id})`,
  };
}

/** Whether a cancel really went through: not refused, and no provider error inside. */
const cancelSucceeded = (outcome: ExecutorOutcome): boolean => {
  if (!outcome.ok) {
    return false;
  }
  const data = outcome.data as { errors?: unknown[]; isError?: boolean } | null;
  return !(data?.isError || data?.errors?.length);
};

/**
 * Keeps the oldest live ticket and cancels every other live ticket of the
 * thread, so a duplicate a failed cleanup left behind is settled by the next
 * call. Returns the winner and any duplicate that could not be canceled.
 */
async function settleThread(
  deps: MigrationTicketDeps,
  ctx: ProviderContext,
  scope: MigrationTicketScope,
  tickets: ThreadTicket[]
): Promise<{ left: string[]; winner: ThreadTicket | undefined }> {
  const winner = threadWinner(tickets);
  const extras = tickets.filter(
    (ticket) => live(ticket) && ticket.identifier !== winner?.identifier
  );
  const left: string[] = [];
  for (const extra of extras) {
    rememberCancellable(scope, extra.identifier);
    let ok = false;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one cancel at a time, so a failure names its ticket.
      ok = cancelSucceeded(await deps.cancel(ctx, extra.identifier));
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
    }
    logOpsEvent("migration.ticket.duplicate_cancelled", {
      duplicateOf: winner?.identifier,
      issue: extra.identifier,
      outcome: ok ? "ok" : "error",
    });
    if (!ok) {
      left.push(extra.identifier);
    }
  }
  return { left, winner };
}

const withLeftovers = (
  result: MigrationTicketResult,
  left: string[]
): MigrationTicketResult =>
  left.length > 0 && "identifier" in result
    ? {
        ...result,
        duplicatesLeft: left,
        warning: `Duplicate tickets ${left.join(", ")} could not be canceled; the next call retries. Mention the ticket link only, and say nothing about duplicates to the rep.`,
      }
    : result;

/**
 * The thread's ticket found again: its Slack sync is checked and repaired,
 * because the connected thread is how triage's reply and reporter updates
 * reach the rep. The repair passes no title, so the 'Ask from' title stays.
 */
async function existingTicket(
  deps: MigrationTicketDeps,
  ctx: ProviderContext,
  ticket: ThreadTicket,
  permalink: string
): Promise<MigrationTicketResult> {
  const synced = await deps.synced(ctx, ticket.identifier);
  const threadSynced =
    synced === false
      ? await deps.syncSlack(ctx, ticket.identifier, { url: permalink })
      : synced === true;
  return {
    existing: true,
    identifier: ticket.identifier,
    threadSynced,
    url: ticket.url,
  };
}

/**
 * After its own create, a filer re-reads the thread. Two filings racing in
 * one thread both see no ticket and both create; the oldest live ticket wins,
 * and every newer one is canceled. A cancel that fails is reported, never
 * returned as a clean success, and the next call retries it.
 */
async function settleFiled(
  deps: MigrationTicketDeps,
  ctx: ProviderContext,
  scope: MigrationTicketScope,
  issue: { identifier: string; url: string },
  link: { title: string; url: string }
): Promise<MigrationTicketResult> {
  rememberCancellable(scope, issue.identifier);
  const { left, winner } = await settleThread(
    deps,
    ctx,
    scope,
    await deps.thread(scope, ctx)
  );
  if (winner && winner.identifier !== issue.identifier) {
    return withLeftovers(
      await existingTicket(deps, ctx, winner, link.url),
      left
    );
  }
  const threadSynced = await deps.syncSlack(ctx, issue.identifier, link);
  logOpsEvent(
    threadSynced
      ? "migration.ticket.filed"
      : "migration.ticket.thread_unsynced",
    { issue: issue.identifier }
  );
  return withLeftovers({ existing: false, ...issue, threadSynced }, left);
}

/**
 * Files this Slack thread's one ticket, or returns the one it already has
 * (ENG-16581). Team, state, owner, workspace and thread come from the signed
 * Slack session, never from the input.
 */
export async function fileMigrationTicket(
  ctx: ProviderContext,
  raw: unknown,
  overrides: Partial<MigrationTicketDeps> = {}
): Promise<MigrationTicketResult> {
  const deps = { ...defaultDeps, ...overrides };
  const scope = filingScope(ctx.session);
  if (!scope) {
    return {
      error:
        "Only a person in a ticket-filing channel's own thread can file this ticket.",
    };
  }
  const input = migrationTicketInputSchema.parse(raw);
  const permalink = slackThreadPermalink(scope.channelId, scope.threadTs);
  try {
    // One ticket per thread: every one ends with this thread's scope block.
    // Extra live tickets a failed cleanup left are canceled here.
    const { left, winner } = await settleThread(
      deps,
      ctx,
      scope,
      await deps.thread(scope, ctx)
    );
    if (winner) {
      return withLeftovers(
        await existingTicket(deps, ctx, winner, permalink),
        left
      );
    }
    const missing = missingFields(input);
    if (missing.length > 0) {
      return {
        missing,
        reason:
          "Ask the rep for exactly these in one message, then call again with everything.",
      };
    }
    const complete = input as Complete;
    const requester = await deps.requester(scope.userId);
    if (requester.status !== "known") {
      return {
        error:
          "The requester's Slack email could not be read, so this ticket cannot be filed here. Ask them to report it with /acquisityasks.",
      };
    }
    const covered = await candidateCheck(deps, ctx, complete);
    if (covered) {
      return covered;
    }
    const facts = await workspaceFacts(
      deps,
      ctx,
      scope,
      complete,
      requester.email
    );
    if (!("affectedEmail" in facts)) {
      return facts;
    }
    const link = { title: `Ask from ${requester.email}`, url: permalink };
    const result = await deps.create(ctx, {
      description: migrationTicketDescription(complete, scope, {
        ...facts,
        reporterEmail: requester.email,
      }),
      link,
      title: clean(complete.title).slice(0, 160),
    });
    if (!result.ok) {
      return { error: "Linear did not accept the ticket." };
    }
    let issue: { identifier: string; url: string };
    try {
      issue = confirmedIssue(result.data);
    } catch {
      return {
        error:
          "Linear accepted the request but did not return a confirmed ticket. Do not retry automatically.",
      };
    }
    return await settleFiled(deps, ctx, scope, issue, link);
  } catch (error) {
    if (ctx.abortSignal.aborted) {
      throw error;
    }
    return {
      error:
        "The ticket outcome could not be confirmed. Do not retry automatically.",
    };
  }
}
