import { callLinearGraphQL } from "eve/channels/linear";
import { z } from "zod";
import { linearAuth } from "./constants.js";
import { executorClient } from "./executor/client.js";
import {
  createMigrationTicket,
  type ExecutorOutcome,
  type ProviderContext,
} from "./executor/dispatch.js";
import { findRelatedIssues } from "./linear-api.js";
import { confirmedIssue } from "./linear-ticket-report.js";
import {
  customerEmailSchema,
  lookupCustomer,
  PRODUCTION_READ_QUERY_ARGS,
} from "./lookup-customer.js";
import {
  filingScope,
  MIGRATION_TICKET_OWNER,
  type MigrationLinearTicket,
  type MigrationTicketScope,
  migrationScopeBlock,
  slackThreadPermalink,
  threadKey,
} from "./migration-ticket-scope.js";
import { logOpsEvent } from "./ops-log.js";
import {
  callPlanetscaleReadQuery,
  parseReadQueryResult,
} from "./planetscale.js";
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

interface IssueRef {
  identifier: string;
  stateType: string;
  title?: string;
  url: string;
}

export type MigrationTicketResult =
  | { existing: true; identifier: string; url: string }
  | { existing: false; identifier: string; threadSynced: boolean; url: string }
  | { missing: string[]; reason: string }
  | {
      candidates: { identifier: string; title: string; url: string }[];
      reason: string;
    }
  | { error: string };

export interface MigrationTicketDeps {
  create: (
    ctx: ProviderContext,
    ticket: MigrationLinearTicket
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
  related: (phrases: string[], ctx: ProviderContext) => Promise<IssueRef[]>;
  requester: (userId: string) => Promise<SlackRequester>;
  search: (phrases: string[], ctx: ProviderContext) => Promise<IssueRef[]>;
  syncSlack: (
    ctx: ProviderContext,
    issue: string,
    link: { title: string; url: string }
  ) => Promise<boolean>;
}

const searchIssues = async (
  phrases: string[],
  ctx: ProviderContext
): Promise<IssueRef[]> =>
  (
    await findRelatedIssues(
      { phrases, scope: "duplicates", windowed: false },
      { client: executorClient(ctx), signal: ctx.abortSignal }
    )
  ).issues;

const runRead = (ctx: ProviderContext) => (query: string) =>
  callPlanetscaleReadQuery(ctx, { ...PRODUCTION_READ_QUERY_ARGS, query });

const RECORD_TABLE = {
  company: "crm_company",
  contact: "crm_contact",
  deal: "crm_deal",
} as const;

const SLACK_LINK_MUTATION = `mutation MigrationSlackThread($issueId: String!, $url: String!, $title: String!) {
  attachmentLinkSlack(issueId: $issueId, url: $url, title: $title, syncToCommentThread: true) { success }
}`;
const SLACK_LINK_TIMEOUT_MS = 15_000;

const defaultDeps: MigrationTicketDeps = {
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
  related: searchIssues,
  requester: (userId) => lookupSlackRequester(userId),
  search: searchIssues,
  async syncSlack(ctx, issue, link) {
    try {
      const { token } = await ctx.getToken(linearAuth);
      const signal = AbortSignal.any([
        ctx.abortSignal,
        AbortSignal.timeout(SLACK_LINK_TIMEOUT_MS),
      ]);
      const result = await callLinearGraphQL<{
        attachmentLinkSlack: { success: boolean };
      }>({
        api: { fetch: (url, init) => fetch(url, { ...init, signal }) },
        credentials: { accessToken: token },
        query: SLACK_LINK_MUTATION,
        queryName: "MigrationSlackThread",
        variables: { issueId: issue, title: link.title, url: link.url },
      });
      return result.attachmentLinkSlack.success === true;
    } catch (error) {
      if (ctx.abortSignal.aborted) {
        throw error;
      }
      return false;
    }
  },
};

const OPEN = (issue: IssueRef) =>
  issue.stateType !== "canceled" && issue.stateType !== "completed";

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
  const scope = ctx.session ? filingScope(ctx.session.auth) : null;
  if (!scope) {
    return {
      error:
        "Only a person in a ticket-filing channel's own thread can file this ticket.",
    };
  }
  const input = migrationTicketInputSchema.parse(raw);
  try {
    // One ticket per thread: every one carries the thread key in its scope
    // block. A canceled one no longer covers the thread.
    const [existing] = (await deps.search([threadKey(scope)], ctx)).filter(
      OPEN
    );
    if (existing) {
      return {
        existing: true,
        identifier: existing.identifier,
        url: existing.url,
      };
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
    const reviewed = new Set(complete.reviewedCandidates ?? []);
    const candidates = (await deps.related(complete.searchPhrases, ctx))
      .filter(OPEN)
      .filter((candidate) => !reviewed.has(candidate.identifier));
    if (candidates.length > 0) {
      return {
        candidates: candidates.slice(0, 10).map((candidate) => ({
          identifier: candidate.identifier,
          title: candidate.title ?? "",
          url: candidate.url,
        })),
        reason:
          "Read these open tickets. If one covers this report, reply with its link and say the team is already working on it, and file nothing. Otherwise call again with them in reviewedCandidates.",
      };
    }
    const affectedEmail =
      complete.affectedUser === "reporter"
        ? requester.email
        : complete.affectedUser;
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
    let record: string | null = null;
    if (complete.record) {
      const name = await deps.readRecord(
        ctx,
        complete.record,
        scope.workspace.id
      );
      if (!name) {
        return {
          missing: ["record"],
          reason: `No ${complete.record.type} with that id is in ${scope.workspace.name}. Ask the rep which record it is, or file without one.`,
        };
      }
      record = `${clean(name)} (${complete.record.type} ${complete.record.id})`;
    }
    const link = {
      title: `Ask from ${requester.email}`,
      url: slackThreadPermalink(scope.channelId, scope.threadTs),
    };
    const result = await deps.create(ctx, {
      ...MIGRATION_TICKET_OWNER,
      description: migrationTicketDescription(complete, scope, {
        affectedEmail,
        record,
        reporterEmail: requester.email,
      }),
      links: [link],
      state: "Triage",
      team: "Engineering Team",
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
    // The synced thread is how triage's reply and reporter updates reach the
    // rep. A failed sync leaves the ticket filed; triage still starts.
    const threadSynced = await deps.syncSlack(ctx, issue.identifier, link);
    logOpsEvent(
      threadSynced
        ? "migration.ticket.filed"
        : "migration.ticket.thread_unsynced",
      { issue: issue.identifier }
    );
    return { existing: false, ...issue, threadSynced };
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
