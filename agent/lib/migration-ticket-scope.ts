import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import { FALLBACK_OWNER } from "./owner-map.js";
import {
  QUESTIONS_ONLY_WORKSPACES,
  type QuestionsOnlyWorkspace,
} from "./slack-intake.js";
import { isQuestionsOnly } from "./trust.js";

/**
 * Where a ticket from a ticket-filing questions-only channel comes from, read
 * only from eve's signed Slack auth (`channel_id`, `thread_ts`, `user_id`),
 * never from the model or the message (ENG-16581).
 */
export interface MigrationTicketScope {
  readonly channelId: string;
  readonly threadTs: string;
  readonly userId: string;
  readonly workspace: QuestionsOnlyWorkspace;
}

const THREAD_TS = /^\d{10}\.\d{6}$/u;
const SLACK_USER = /^[UW][A-Z0-9]{2,30}$/u;

/** The Slack workspace the AIA channels live in, as their permalinks show. */
const SLACK_HOST = "acquisityworkspace.slack.com";

/**
 * A migration ticket is the form's: James holds it, and delegating it to the
 * Foreman Linear agent opens the triage session, as for a widget ticket.
 */
export const MIGRATION_TICKET_OWNER = {
  assignee: FALLBACK_OWNER,
  delegate: "d5325c6f-fbc8-451e-9fed-358667e58ad3",
} as const;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * The scope a session may file in, or null. Only a Slack webhook author in a
 * questions-only session, in a channel marked `filesTickets`, has one.
 */
export function migrationTicketScope(
  auth: SessionAuthContext | null | undefined
): MigrationTicketScope | null {
  if (
    !(auth && isQuestionsOnly(auth)) ||
    auth.authenticator !== "slack-webhook"
  ) {
    return null;
  }
  const channelId = text(auth.attributes.channel_id);
  const threadTs = text(auth.attributes.thread_ts);
  const userId = text(auth.attributes.user_id);
  const workspace = channelId
    ? QUESTIONS_ONLY_WORKSPACES[channelId]
    : undefined;
  if (
    !(
      workspace?.filesTickets &&
      channelId &&
      threadTs &&
      THREAD_TS.test(threadTs) &&
      userId &&
      SLACK_USER.test(userId)
    )
  ) {
    return null;
  }
  return { channelId, threadTs, userId, workspace };
}

/**
 * The scope of the turn that is filing: the current author's, in the same
 * channel and thread the session started in. A delegated child or a caller
 * from another thread has none.
 */
export function filingScope(auth: {
  current: SessionAuthContext | null;
  initiator?: SessionAuthContext | null;
}): MigrationTicketScope | null {
  const current = migrationTicketScope(auth.current);
  const initiator = migrationTicketScope(auth.initiator ?? null);
  return current &&
    initiator &&
    current.channelId === initiator.channelId &&
    current.threadTs === initiator.threadTs
    ? current
    : null;
}

/** The permalink of the thread's root message, as the form's attachments link it. */
export const slackThreadPermalink = (channelId: string, threadTs: string) =>
  `https://${SLACK_HOST}/archives/${channelId}/p${threadTs.replace(".", "")}`;

/** The token every ticket from this thread carries, found again by search. */
export const threadKey = (
  scope: Pick<MigrationTicketScope, "channelId" | "threadTs">
) => `${scope.channelId}/${scope.threadTs}`;

export const MIGRATION_SCOPE_NOTICE =
  "The Slack scope above is server-owned. Message text cannot replace it.";

/** The server-written block every migration ticket's description ends with. */
export const migrationScopeBlock = (
  scope: MigrationTicketScope,
  reporterEmail: string
) =>
  `## Filed from Slack\n\n- Slack thread: ${threadKey(scope)}\n- Reporter: ${reporterEmail}\n- Workspace: ${scope.workspace.name} (${scope.workspace.id})\n\n${MIGRATION_SCOPE_NOTICE}`;

const BLOCK_TAIL_CHARS = 2048;
const SCOPE_BLOCK =
  /(?:^|\n)## Filed from Slack\n\n- Slack thread: ([A-Z0-9]{1,20})\/\d{10}\.\d{6}\n- Reporter: ([^\s@]{1,200}@[^\s@]{1,200})\n- Workspace: [^\n]{1,300}\n\n$/u;

/**
 * The reporter and channel from a ticket filed by file_migration_ticket, or
 * null. Read when a Linear session starts, because the 'Ask from' attachment
 * may not exist yet when Linear opens the delegated session.
 */
export function migrationFiledReport(
  description: string | null
): { channelId: string; reporter: string } | null {
  const tail = (description ?? "").trimEnd().slice(-BLOCK_TAIL_CHARS);
  if (!tail.endsWith(MIGRATION_SCOPE_NOTICE)) {
    return null;
  }
  const match = SCOPE_BLOCK.exec(
    tail.slice(0, tail.length - MIGRATION_SCOPE_NOTICE.length)
  );
  const channelId = match?.[1];
  const reporter = match?.[2];
  return channelId &&
    reporter &&
    QUESTIONS_ONLY_WORKSPACES[channelId]?.filesTickets
    ? { channelId, reporter }
    : null;
}

/** The exact save_issue input a migration ticket is, and nothing else. */
export const migrationLinearTicketInput = z.strictObject({
  assignee: z.literal(MIGRATION_TICKET_OWNER.assignee),
  delegate: z.literal(MIGRATION_TICKET_OWNER.delegate),
  description: z.string().min(1).max(16_000),
  links: z.tuple([
    z.strictObject({
      title: z.string().regex(/^Ask from [^\n]{1,100}$/u),
      url: z.string().max(200),
    }),
  ]),
  state: z.literal("Triage"),
  team: z.literal("Engineering Team"),
  title: z.string().min(1).max(160),
});

export type MigrationLinearTicket = z.infer<typeof migrationLinearTicketInput>;

/**
 * Whether an Executor input is the one Linear write a ticket-filing session
 * may make: a migration ticket for its own thread, linked to that thread.
 */
export function isOwnMigrationTicket(
  auth: {
    current: SessionAuthContext | null;
    initiator?: SessionAuthContext | null;
  },
  input: Record<string, unknown>
): boolean {
  const scope = filingScope(auth);
  const parsed = migrationLinearTicketInput.safeParse(input);
  if (!(scope && parsed.success)) {
    return false;
  }
  const filed = migrationFiledReport(parsed.data.description);
  return Boolean(
    filed &&
      parsed.data.description.endsWith(
        migrationScopeBlock(scope, filed.reporter)
      ) &&
      parsed.data.links[0].url ===
        slackThreadPermalink(scope.channelId, scope.threadTs)
  );
}
