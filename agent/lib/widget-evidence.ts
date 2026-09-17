import { z } from "zod";
import { readWidgetOwnership } from "./executor/dispatch.js";
import { providerData } from "./support/conversation.js";
import { type WidgetContext, widgetContextSchema } from "./widget-scope.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s'"\\{},@]+@[^\s'"\\{},@]+$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const CANDIDATE_LIMIT = 100;

export interface IdentifierCandidates {
  emails: string[];
  slugs: string[];
  uuids: string[];
}
export interface OwnedIdentifiers {
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
 * ponytail: organization, member, user and outreach_campaign only; add email accounts,
 * domains and submissions when the red-team shows those identifiers blocking real answers.
 */
export function buildOwnershipQuery(
  context: WidgetContext,
  candidates: IdentifierCandidates
): string {
  const scope = widgetContextSchema.parse(context);
  const uuids = literalArray(candidates.uuids, UUID, "uuid");
  const slugs = literalArray(candidates.slugs, SLUG, "text");
  const emails = literalArray(candidates.emails, EMAIL, "text");
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
    ) x where x.id = any(${uuids})), '[]'::jsonb) as uuids,
    coalesce((select jsonb_agg(lower(a.slug)) from authorized a where lower(a.slug) = any(${slugs})), '[]'::jsonb) as slugs,
    coalesce((select jsonb_agg(lower(u.email)) from "user" u
      join member m on m.user_id = u.id and m.deleted_at is null
      join authorized a on a.id = m.organization_id
      where lower(u.email) = any(${emails})), '[]'::jsonb) as emails`;
}

const resultSchema = z.object({
  rows: z
    .array(
      z.object({
        authorized: z.boolean(),
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
    emails: new Set(row.emails),
    slugs: new Set(row.slugs),
    uuids: new Set(row.uuids.map((id) => id.toLowerCase())),
  };
}
