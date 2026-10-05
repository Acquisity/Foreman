import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { operationPath } from "#lib/executor/bindings.js";
import {
  invokeProvider,
  type ProviderContext,
} from "#lib/executor/dispatch.js";
import { PRODUCTION_READ_QUERY_ARGS } from "#lib/lookup-customer.js";
import { logOpsEvent } from "#lib/ops-log.js";
import { providerData } from "#lib/support/conversation.js";
import {
  isWidgetSupport,
  requireWidgetContext,
  type WidgetContext,
  widgetContextSchema,
} from "#lib/widget-scope.js";

const CONTACT_LIMIT = 10;
const EMAIL_LIMIT = 10;

export const widgetCrmContactInput = z.strictObject({
  email: z
    .email()
    .max(320)
    .describe(
      "The exact email address to look for on this workspace's CRM people."
    ),
  name: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .optional()
    .describe(
      "Optional part of the person's display name, to read that person's saved emails."
    ),
});
export type WidgetCrmContactInput = z.infer<typeof widgetCrmContactInput>;

const contact = z.object({
  emails: z.array(z.string().max(320)).max(EMAIL_LIMIT),
  emailsTruncated: z.boolean(),
  id: z.string().max(64),
  name: z.string().max(200),
});

export const widgetCrmContactOutput = z.union([
  z.object({
    caveats: z.array(z.string().max(300)).max(4),
    emailMatches: z.array(contact).max(CONTACT_LIMIT),
    emailMatchesTruncated: z.boolean(),
    nameMatches: z.array(contact).max(CONTACT_LIMIT).nullable(),
    nameMatchesTruncated: z.boolean(),
    observedAt: z.string().max(64),
    source: z.string().max(300),
    status: z.literal("ok"),
    workspace: z.string().max(500),
  }),
  z.object({
    message: z.string().max(300),
    status: z.enum(["unavailable", "denied"]),
  }),
]);
export type WidgetCrmContactOutput = z.infer<typeof widgetCrmContactOutput>;

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Fixed statement; every contact read hangs off the authorized workspace. */
export function buildWidgetCrmContactQuery(
  context: WidgetContext,
  raw: WidgetCrmContactInput
) {
  const input = widgetCrmContactInput.parse(raw);
  const scope = widgetContextSchema.parse(context);
  // Merged people are deleted survivors' shadows; only live people are read.
  const contacts = (where: string) => `coalesce((select json_agg(x) from (
      select c.id::text as id, left(c.name, 200) as name,
        coalesce((select json_agg(e.email) from (
          select left(ce.email, 320) as email from crm_email ce
          where ce.contact_id = c.id and ce.deleted_at is null
          order by ce.sort_order, ce.created_at
          limit ${EMAIL_LIMIT + 1}) e), '[]'::json) as emails
      from crm_contact c join authorized a on a.id = c.organization_id
      where c.deleted_at is null and c.merged_into_contact_id is null
        and ${where}
      order by c.updated_at desc
      limit ${CONTACT_LIMIT + 1}) x), '[]'::json)`;
  const byEmail = contacts(`exists (select 1 from crm_email m
      where m.contact_id = c.id and m.deleted_at is null
        and lower(m.email) = lower(${literal(input.email)}))`);
  const byName = input.name
    ? contacts(`strpos(lower(c.name), lower(${literal(input.name)})) > 0`)
    : "null::json";
  return `with authorized as (
    select o.id, o.name
    from organization o join member m on m.organization_id = o.id
    where o.id = '${scope.organizationId}'::uuid
      and m.user_id = '${scope.userId}'::uuid
      and m.role in ('owner','admin')
      and o.deleted_at is null and m.deleted_at is null
      and (o.partner_id is null or o.partner_id = '${scope.partnerId}'::uuid)
    limit 1)
    select (select count(*) = 1 from authorized) as authorized,
      (select name from authorized) as workspace,
      ${byEmail} as email_matches,
      ${byName} as name_matches`;
}

const contactRow = z.object({
  emails: z.array(z.string()),
  id: z.string(),
  name: z.string(),
});
const rowSchema = z.object({
  authorized: z.boolean(),
  email_matches: z.array(contactRow),
  name_matches: z.array(contactRow).nullable(),
  workspace: z.string().nullable(),
});

const bounded = (rows: z.infer<typeof contactRow>[]) =>
  rows.slice(0, CONTACT_LIMIT).map((row) => ({
    emails: row.emails.slice(0, EMAIL_LIMIT).map((e) => e.slice(0, 320)),
    emailsTruncated: row.emails.length > EMAIL_LIMIT,
    id: row.id.slice(0, 64),
    name: row.name.slice(0, 200),
  }));

export async function readWidgetCrmContact(
  ctx: ProviderContext,
  input: WidgetCrmContactInput
): Promise<WidgetCrmContactOutput> {
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  try {
    ctx.abortSignal.throwIfAborted();
    const query = buildWidgetCrmContactQuery(scope, input);
    const provided = await invokeProvider(
      ctx,
      operationPath("planetscale.readQuery"),
      { ...PRODUCTION_READ_QUERY_ARGS, query, use_replica: false },
      undefined,
      { maxBytes: 128 * 1024, timeoutMs: 50_000 }
    );
    if (!provided.ok || (provided.http && provided.http.status !== 200)) {
      throw new Error("Evidence provider unavailable.");
    }
    const [result] = z
      .object({
        rows: z
          .array(
            rowSchema.extend({
              name_matches: input.name ? z.array(contactRow) : z.null(),
            })
          )
          .length(1),
        success: z.literal(true),
        warnings: z.array(z.unknown()).max(0).optional(),
      })
      .parse(providerData(provided.data)).rows;
    if (!(result.authorized && result.workspace)) {
      return {
        message: "Workspace access could not be verified.",
        status: "denied",
      };
    }
    const emailRows = result.email_matches;
    const nameRows = result.name_matches;
    return {
      caveats: [
        ...(emailRows.length === 0
          ? ["No live CRM person in this workspace carries this email address."]
          : []),
        "Only live CRM people in this workspace are read; deleted and merged people, companies, and leads are not.",
        "The CRM does not require emails to be unique, so a match here shows the address is already saved on that person, not that a save was refused because of it.",
      ],
      emailMatches: bounded(emailRows),
      emailMatchesTruncated: emailRows.length > CONTACT_LIMIT,
      nameMatches: nameRows ? bounded(nameRows) : null,
      nameMatchesTruncated: (nameRows?.length ?? 0) > CONTACT_LIMIT,
      observedAt: new Date().toISOString(),
      source: "Acquisity product database; this workspace's CRM people.",
      status: "ok",
      workspace: result.workspace,
    };
  } catch (error) {
    logOpsEvent(
      "widget.crm_contact.unavailable",
      { outcome: "error" },
      console.warn
    );
    if (ctx.abortSignal.aborted) {
      throw error;
    }
    return {
      message: "The CRM records could not be read for this workspace.",
      status: "unavailable",
    };
  }
}

const tool = defineTool({
  approval: (ctx) =>
    isWidgetSupport(ctx.session.auth.initiator)
      ? "not-applicable"
      : { reason: "Support widget investigations only.", type: "denied" },
  description:
    "Read this workspace's live CRM people (contacts) that already carry an exact email address, matched case-insensitively, and optionally the people whose display name contains a given fragment, with the emails saved on each. " +
    "Use it when a CRM email edit did not save, cleared, or reverted, or when the customer asks whether an address already belongs to another person. Pass the attempted email address and, when known, the person's name as the optional name fragment. If the attempted email address is not in the conversation, ask for it. " +
    "Returns at most 10 people with 10 emails each, with truncation flags. Deleted or merged people, companies and leads are not read. unavailable means the records could not be read, distinct from an empty result.",
  execute: (input, ctx) => readWidgetCrmContact(ctx, input),
  inputSchema: widgetCrmContactInput,
  outputSchema: widgetCrmContactOutput,
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) ? tool : null,
  },
});
