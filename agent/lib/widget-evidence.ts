import { z } from "zod";
import { readWidgetOwnership } from "./executor/dispatch.js";
import { providerData } from "./support/conversation.js";
import { type WidgetContext, widgetContextSchema } from "./widget-scope.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s'"\\{},@]+@[^\s'"\\{},@]+$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
const CANDIDATE_LIMIT = 100;

export interface IdentifierCandidates {
  /** Bare domain names. Optional so callers that never see one need not pass it. */
  domains?: string[];
  emails: string[];
  slugs: string[];
  uuids: string[];
}
export interface OwnedIdentifiers {
  domains: Set<string>;
  emails: Set<string>;
  slugs: Set<string>;
  uuids: Set<string>;
}

const literalArray = (values: string[], pattern: RegExp, cast: string) => {
  const valid = values.filter((value) => pattern.test(value));
  if (valid.length !== values.length || valid.length > CANDIDATE_LIMIT) {
    throw new Error("Invalid identifier candidate.");
  }
  return `'{${valid.map((value) => value.toLowerCase()).join(",")}}'::${cast}[]`;
};

/**
 * One fixed statement: which candidate identifiers belong to the verified workspace.
 * Membership is re-checked in the same snapshot, so a revoked user resolves nothing.
 *
 * An investigation names the customer's own things constantly: a lead's email,
 * the inbox a campaign sends from, a thread, a sending domain. Anything not
 * resolved here is treated as foreign and blocks the reply, so this covers the
 * objects a support answer actually mentions. Every branch joins through
 * `authorized`, which is the single place the verified organization enters the
 * query: an identifier that exists only in another workspace resolves to
 * nothing, exactly as an unknown one does.
 */
export function buildOwnershipQuery(
  context: WidgetContext,
  candidates: IdentifierCandidates
): string {
  const scope = widgetContextSchema.parse(context);
  const uuids = literalArray(candidates.uuids, UUID, "uuid");
  const slugs = literalArray(candidates.slugs, SLUG, "text");
  const emails = literalArray(candidates.emails, EMAIL, "text");
  const domains = literalArray(candidates.domains ?? [], DOMAIN, "text");
  return `with authorized as (
    select o.id, o.slug from organization o join member m on m.organization_id = o.id
    where o.id = '${scope.organizationId}'::uuid and m.user_id = '${scope.userId}'::uuid
      and o.deleted_at is null and m.deleted_at is null and m.role in ('owner', 'admin')
      and (o.partner_id is null or o.partner_id = '${scope.partnerId}'::uuid)
  )
  select (select count(*) = 1 from authorized) as authorized,
    coalesce((select jsonb_agg(x.id) from (
      select a.id from authorized a
      union select m.user_id as id from member m join authorized a on a.id = m.organization_id where m.deleted_at is null
      union select c.id from outreach_campaign c join authorized a on a.id = c.organization_id
      union select t.id from crm_message_thread t join authorized a on a.id = t.organization_id
      union select ct.id from crm_contact ct join authorized a on a.id = ct.organization_id
      union select l.id from crm_lead l join authorized a on a.id = l.organization_id
      union select i.id from mail_inbox i join authorized a on a.id = i.organization_id
      union select d.id from mail_domain d join authorized a on a.id = d.organization_id
    ) x where x.id = any(${uuids})), '[]'::jsonb) as uuids,
    coalesce((select jsonb_agg(lower(a.slug)) from authorized a where lower(a.slug) = any(${slugs})), '[]'::jsonb) as slugs,
    coalesce((select jsonb_agg(distinct e.email) from (
      select lower(u.email) as email from "user" u
        join member m on m.user_id = u.id and m.deleted_at is null
        join authorized a on a.id = m.organization_id
      union select lower(t.prospect_email) from crm_message_thread t join authorized a on a.id = t.organization_id
      union select lower(ce.email) from crm_email ce
        join crm_contact ct on ct.id = ce.contact_id join authorized a on a.id = ct.organization_id
      union select lower(ce.email) from crm_email ce
        join crm_lead l on l.id = ce.lead_id join authorized a on a.id = l.organization_id
      union select lower(i.email) from mail_inbox i join authorized a on a.id = i.organization_id
    ) e where e.email = any(${emails})), '[]'::jsonb) as emails,
    coalesce((select jsonb_agg(distinct lower(d.domain)) from mail_domain d
      join authorized a on a.id = d.organization_id
      where lower(d.domain) = any(${domains})), '[]'::jsonb) as domains`;
}

const resultSchema = z.object({
  rows: z
    .array(
      z.object({
        authorized: z.boolean(),
        domains: z.array(z.string()).max(CANDIDATE_LIMIT),
        emails: z.array(z.string()).max(CANDIDATE_LIMIT),
        slugs: z.array(z.string()).max(CANDIDATE_LIMIT),
        uuids: z.array(z.string()).max(CANDIDATE_LIMIT),
      })
    )
    .length(1),
  success: z.literal(true),
});

/** Any unresolved candidate is foreign; the caller blocks on it. */
export async function resolveOwnedIdentifiers(
  scope: WidgetContext,
  candidates: IdentifierCandidates,
  signal: AbortSignal = AbortSignal.timeout(50_000)
): Promise<OwnedIdentifiers> {
  const query = buildOwnershipQuery(scope, candidates);
  const data = await readWidgetOwnership(query, signal);
  const [row] = resultSchema.parse(providerData(data)).rows;
  if (!row.authorized) {
    throw new Error("Current workspace access could not be verified.");
  }
  return {
    domains: new Set(row.domains),
    emails: new Set(row.emails),
    slugs: new Set(row.slugs),
    uuids: new Set(row.uuids.map((id) => id.toLowerCase())),
  };
}
