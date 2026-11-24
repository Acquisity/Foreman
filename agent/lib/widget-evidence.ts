import { z } from "zod";
import { readContextBody } from "./acquisity-origin.js";
import { readWidgetOwnership } from "./executor/dispatch.js";
import { providerData } from "./support/conversation.js";
import { postScopedAppRoute } from "./widget-app-diagnostics.js";
import { WIDGET_ENDPOINT_MANIFEST } from "./widget-endpoint-manifest.js";
import { type WidgetContext, widgetContextSchema } from "./widget-scope.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s'"\\{},@]+@[^\s'"\\{},@]+$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
const CANDIDATE_LIMIT = 100;
// The endpoint's own limits: a longer value is never owned, so it is not sent.
const EMAIL_MAX = 320;
const DOMAIN_MAX = 253;

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

const checkedCandidates = (values: string[], pattern: RegExp) => {
  const valid = values.filter((value) => pattern.test(value));
  if (valid.length !== values.length || valid.length > CANDIDATE_LIMIT) {
    throw new Error("Invalid identifier candidate.");
  }
  return valid.map((value) => value.toLowerCase());
};

const upTo = (values: string[], max: number) =>
  values.filter((value) => value.length <= max);

/**
 * The bug report's membership check: the scoped user is a current member of
 * the scoped workspace, in any role. The owners-and-admins endpoint can't
 * answer it, so this one fixed statement still reads the database.
 */
export function buildMembershipQuery(context: WidgetContext): string {
  const scope = widgetContextSchema.parse(context);
  return `select count(*) = 1 as authorized from organization o join member m on m.organization_id = o.id
    where o.id = '${scope.organizationId}'::uuid and m.user_id = '${scope.userId}'::uuid
      and o.deleted_at is null and m.deleted_at is null
      and (o.partner_id is null or o.partner_id = '${scope.partnerId}'::uuid)`;
}

const membershipSchema = z.object({
  rows: z.array(z.object({ authorized: z.boolean() })).length(1),
  success: z.literal(true),
});

/** The scoped user is not a current owner or admin (or, for the membership check, member) of the workspace. */
export class WorkspaceAccessDenied extends Error {
  constructor() {
    super("Current workspace access could not be verified.");
  }
}

/** Throws WorkspaceAccessDenied unless the scoped user is a current member of the workspace. */
export async function verifyWorkspaceMember(
  scope: WidgetContext,
  signal: AbortSignal = AbortSignal.timeout(50_000)
): Promise<void> {
  const data = await readWidgetOwnership(buildMembershipQuery(scope), signal);
  const [row] = membershipSchema.parse(providerData(data)).rows;
  if (!row.authorized) {
    throw new WorkspaceAccessDenied();
  }
}

// The response below is version 1's; a later version keeps this one live.
const OWNED_IDENTIFIERS = WIDGET_ENDPOINT_MANIFEST.endpoints.find(
  (entry) => entry.name === "owned-identifiers" && entry.version === 1
);
const OWNED_MAX_BYTES = 64 * 1024;
const ownedList = z.array(z.string().max(EMAIL_MAX)).max(CANDIDATE_LIMIT);
const deniedResponse = z.object({ status: z.literal("denied") });
const ownedResponse = z.object({
  sections: z.object({
    owned: z.object({
      domains: ownedList,
      emails: ownedList,
      slugs: ownedList,
      uuids: ownedList,
    }),
  }),
  status: z.literal("ok"),
});

/**
 * Which candidates the verified workspace owns, from Acquisity's
 * owned-identifiers endpoint (ENG-20527). It re-checks that the conversation
 * is this user's in this workspace and that they are a current owner or
 * admin. Any unresolved candidate is foreign and the caller blocks on it. A
 * denial is the only answer that means "not allowed"; any other failure
 * throws, so the caller refuses instead of reading it as nothing owned.
 */
export async function resolveOwnedIdentifiers(
  scope: WidgetContext,
  candidates: IdentifierCandidates,
  signal: AbortSignal = AbortSignal.timeout(50_000),
  request: typeof fetch = fetch
): Promise<OwnedIdentifiers> {
  if (!OWNED_IDENTIFIERS) {
    throw new Error("The owned-identifiers endpoint is not in the manifest.");
  }
  const input = {
    domains: upTo(
      checkedCandidates(candidates.domains ?? [], DOMAIN),
      DOMAIN_MAX
    ),
    emails: upTo(checkedCandidates(candidates.emails, EMAIL), EMAIL_MAX),
    slugs: checkedCandidates(candidates.slugs, SLUG),
    uuids: checkedCandidates(candidates.uuids, UUID),
  };
  const response = await postScopedAppRoute(
    widgetContextSchema.parse(scope),
    OWNED_IDENTIFIERS.path,
    input,
    signal,
    request
  );
  if (response.status !== 200 && response.status !== 403) {
    response.body?.cancel().catch(() => undefined);
    throw new Error("Support identifier resolution is unavailable.");
  }
  const body: unknown = await readContextBody(
    response,
    signal,
    OWNED_MAX_BYTES
  );
  if (response.status === 403) {
    if (deniedResponse.safeParse(body).success) {
      throw new WorkspaceAccessDenied();
    }
    throw new Error("Support identifier resolution is unavailable.");
  }
  const { owned } = ownedResponse.parse(body).sections;
  return {
    domains: new Set(owned.domains),
    emails: new Set(owned.emails),
    slugs: new Set(owned.slugs),
    uuids: new Set(owned.uuids.map((id) => id.toLowerCase())),
  };
}
