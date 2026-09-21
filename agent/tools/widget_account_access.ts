import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
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

const INVITATION_LIMIT = 25;
const ROLE_LIMIT = 4;
const AUTH_ERROR_CLASS_LIMIT = 10;
const SENTRY_WINDOW_DAYS = 14;
const sentryOrgSlug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/);

const role = z.enum(["owner", "admin", "member", "client"]);
const timestamp = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));
const count = z.number().int().nonnegative();

const organization = z.object({
  name: z.string().max(600),
  onboardingStatus: z
    .enum(["pending", "completed", "reset", "skipped"])
    .nullable(),
  partnerManaged: z.boolean(),
  slug: z.string().max(200).nullable(),
});
const membership = z.object({
  memberSince: timestamp.nullable(),
  role,
});
/** Support-safe account state only: status and dates, never a password hash, session or token. */
const account = z.object({
  banExpiresAt: timestamp.nullable(),
  banned: z.boolean(),
  banReason: z.string().max(300).nullable(),
  emailVerified: z.boolean(),
  lastLoginAt: timestamp.nullable(),
  onboardingCallScheduled: z.boolean(),
  onboardingComplete: z.boolean(),
  onboardingCompletedAt: timestamp.nullable(),
  twoFactorEnabled: z.boolean(),
});
const onboarding = z
  .object({
    businessInfo: z.boolean(),
    coldEmail: z.boolean(),
    flowType: z.enum(["workspace", "full"]),
    goals: z.boolean(),
    icp: z.boolean(),
    lead: z.boolean(),
    niche: z.boolean(),
    offer: z.boolean(),
    personalInfo: z.boolean(),
    updatedAt: timestamp,
  })
  .nullable();
const seatCount = z.object({ count, role });
/** Pending invitations are this workspace's own outbound invites; the invited email is the diagnostic. */
const invitation = z.object({
  createdAt: timestamp,
  email: z.string().max(320),
  expired: z.boolean(),
  expiresAt: timestamp.nullable(),
  role,
  status: z.enum(["pending", "accepted", "expired", "revoked"]),
});
/**
 * Acquisity sends no tagged sign-in failures to Sentry, so these are every
 * unresolved error recorded against the user, never proven auth failures.
 */
const userErrorSignals = z.union([
  z.object({
    classes: z.array(z.string().max(200)).max(AUTH_ERROR_CLASS_LIMIT),
    lastSeenAt: timestamp.nullable(),
    scope: z.literal(
      "all unresolved errors recorded for this user; not filtered to sign-in"
    ),
    status: z.literal("ok"),
    total: count,
    windowDays: z.literal(SENTRY_WINDOW_DAYS),
  }),
  z.object({
    reason: z.enum([
      "sentry_unconfigured",
      "sentry_unreachable",
      "sentry_malformed",
    ]),
    status: z.literal("unavailable"),
  }),
]);

export const widgetAccountAccessInput = z.strictObject({});
export type WidgetAccountAccessInput = z.infer<typeof widgetAccountAccessInput>;

export const widgetAccountAccessOutput = z.union([
  z.object({
    account,
    caveats: z.array(z.string()).max(6),
    membership,
    observedAt: timestamp,
    onboarding,
    organization,
    pendingInvitations: z.array(invitation).max(INVITATION_LIMIT),
    seats: z.object({
      byRole: z.array(seatCount).max(ROLE_LIMIT),
      planLimit: z.null(),
      used: count,
    }),
    source: z.literal(
      "Acquisity product database; saved account and onboarding state, not a live auth or billing check"
    ),
    status: z.literal("ok"),
    userErrorSignals,
    workspace: z.string().max(500),
  }),
  z.object({
    message: z.string(),
    status: z.enum(["unavailable", "denied"]),
  }),
]);
export type WidgetAccountAccessOutput = z.infer<
  typeof widgetAccountAccessOutput
>;

/**
 * One fixed statement, scoped to the verified user and workspace by construction.
 * Every product read hangs off the authorized CTE, which re-checks a live
 * owner/admin membership in the same snapshot, so a revoked user reads nothing.
 * No password hash, session, token or other member's email is selected.
 */
export function buildAccountAccessQuery(context: WidgetContext): string {
  const scope = widgetContextSchema.parse(context);
  return `with authorized as (
    select o.id, o.slug, left(o.name, 300) as name, o.partner_id as partner_id,
      o.onboarding_status as onboarding_status
    from organization o join member m on m.organization_id = o.id
    where o.id = '${scope.organizationId}'::uuid and m.user_id = '${scope.userId}'::uuid
      and o.deleted_at is null and m.deleted_at is null and m.role in ('owner', 'admin')
      and (o.partner_id is null or o.partner_id = '${scope.partnerId}'::uuid)
  )
  select
    (select count(*) = 1 from authorized) as authorized,
    current_timestamp as "observedAt",
    (select to_jsonb(w) from (
      select a.name, a.slug, (a.partner_id is not null) as "partnerManaged",
        a.onboarding_status as "onboardingStatus"
      from authorized a
    ) w) as organization,
    (select to_jsonb(w) from (
      select m.role, m.created_at as "memberSince"
      from member m join authorized a on a.id = m.organization_id
      where m.user_id = '${scope.userId}'::uuid and m.deleted_at is null limit 1
    ) w) as membership,
    (select to_jsonb(w) from (
      select u.email_verified as "emailVerified", coalesce(u.banned, false) as banned,
        left(u.ban_reason, 300) as "banReason", u.ban_expires as "banExpiresAt",
        coalesce(u.two_factor_enabled, false) as "twoFactorEnabled",
        u.last_login as "lastLoginAt",
        u.onboarding_complete as "onboardingComplete",
        u.onboarding_completed_at as "onboardingCompletedAt",
        coalesce(u.onboarding_call_scheduled, false) as "onboardingCallScheduled"
      from "user" u
      where u.id = '${scope.userId}'::uuid and exists (select 1 from authorized)
    ) w) as account,
    (select to_jsonb(w) from (
      select os.flow_type as "flowType",
        (os.personal_info_form_data is not null) as "personalInfo",
        (os.business_info_form_data is not null) as "businessInfo",
        (os.goals_form_data is not null) as goals,
        (os.icp_form_data is not null) as icp,
        (os.niche_form_data is not null) as niche,
        (os.offer_form_data is not null) as offer,
        (os.cold_email_form_data is not null) as "coldEmail",
        (os.lead_form_data is not null) as lead,
        os.updated_at as "updatedAt"
      from onboarding_session os join authorized a on a.id = os.organization_id
      where os.user_id = '${scope.userId}'::uuid
      order by os.updated_at desc limit 1
    ) w) as onboarding,
    coalesce((select jsonb_agg(to_jsonb(r)) from (
      select mm.role, count(*)::int as count
      from member mm join authorized a on a.id = mm.organization_id
      where mm.deleted_at is null group by mm.role order by mm.role limit ${ROLE_LIMIT}
    ) r), '[]'::jsonb) as seats,
    coalesce((select jsonb_agg(to_jsonb(r)) from (
      select inv.email, inv.role, inv.status, inv.expires_at as "expiresAt",
        (inv.expires_at < current_timestamp) as expired, inv.created_at as "createdAt"
      from invitation inv join authorized a on a.id = inv.organization_id
      where inv.status = 'pending'
      order by inv.created_at desc, inv.id desc limit ${INVITATION_LIMIT}
    ) r), '[]'::jsonb) as invitations`;
}

const CAVEATS = [
  "Saved product state, not a live authentication or billing check.",
  "Seat counts are active members of this workspace; the plan's seat limit comes from billing and is not read here.",
  "Pending invitations are this workspace's own outbound invites; the invited email is shown so an invite-login report can be matched.",
  "userErrorSignals are all unresolved Sentry errors recorded for this user in the window, from any part of the product. Sign-in failures are not tagged in Sentry, so they neither prove nor rule out a failed sign-in.",
];

/** Parse only the provider envelope and declared fields; never forward raw failure bodies. */
export function parseAccountAccess(
  data: unknown,
  context: WidgetContext,
  errors: z.infer<typeof userErrorSignals>
): WidgetAccountAccessOutput {
  const envelope = z
    .object({
      rows: z
        .array(
          z.object({
            account: account.nullable(),
            authorized: z.boolean(),
            invitations: z.array(invitation).max(INVITATION_LIMIT),
            membership: membership.nullable(),
            observedAt: timestamp,
            onboarding,
            organization: organization.nullable(),
            seats: z.array(seatCount).max(ROLE_LIMIT),
          })
        )
        .length(1),
      success: z.literal(true),
      warnings: z.array(z.unknown()).max(0).optional(),
    })
    .parse(providerData(data));
  const [row] = envelope.rows;
  if (!(row.authorized && row.organization && row.membership && row.account)) {
    return {
      message: "Current workspace access could not be verified.",
      status: "denied",
    };
  }
  return widgetAccountAccessOutput.parse({
    account: row.account,
    caveats: CAVEATS,
    membership: row.membership,
    observedAt: row.observedAt,
    onboarding: row.onboarding,
    organization: row.organization,
    pendingInvitations: row.invitations,
    seats: {
      byRole: row.seats,
      planLimit: null,
      used: row.seats.reduce((total, entry) => total + entry.count, 0),
    },
    source:
      "Acquisity product database; saved account and onboarding state, not a live auth or billing check",
    status: "ok",
    userErrorSignals: errors,
    workspace: context.organizationName,
  });
}

const sentryIssue = z
  .object({
    count: z.union([z.number(), z.string()]).nullish(),
    lastSeen: z.string().nullish(),
    metadata: z.object({ type: z.string().nullish() }).passthrough().nullish(),
    title: z.string().nullish(),
    type: z.string().nullish(),
  })
  .passthrough();

/**
 * Aggregate Sentry issues into sanitized counts only: total, last-seen and a
 * bounded set of error classes. Never emit titles verbatim beyond a short class
 * label, message bodies, or event traces. Any unexpected shape reads malformed,
 * which stays distinct from a confirmed empty list.
 * ponytail: tolerant parse; pin the search_issues response schema if it drifts.
 */
export function parseSentryUserErrors(
  data: unknown
): z.infer<typeof userErrorSignals> {
  try {
    const parsed = providerData(data);
    const list = Array.isArray(parsed)
      ? parsed
      : ((parsed as Record<string, unknown> | null)?.issues ??
        (parsed as Record<string, unknown> | null)?.data ??
        (parsed as Record<string, unknown> | null)?.results);
    const issues = z.array(sentryIssue).max(1000).parse(list);
    let total = 0;
    let lastSeenAt: string | null = null;
    const classes: string[] = [];
    for (const issue of issues) {
      const parsedCount = Number(issue.count ?? 1);
      total += Number.isFinite(parsedCount) ? Math.max(0, parsedCount) : 0;
      if (
        issue.lastSeen &&
        Number.isFinite(Date.parse(issue.lastSeen)) &&
        (!lastSeenAt || issue.lastSeen > lastSeenAt)
      ) {
        lastSeenAt = issue.lastSeen;
      }
      const label = (
        issue.metadata?.type ??
        issue.type ??
        issue.title?.split(":")[0] ??
        "error"
      ).slice(0, 200);
      if (!classes.includes(label) && classes.length < AUTH_ERROR_CLASS_LIMIT) {
        classes.push(label);
      }
    }
    return userErrorSignals.parse({
      classes,
      lastSeenAt,
      scope:
        "all unresolved errors recorded for this user; not filtered to sign-in",
      status: "ok",
      total: Math.trunc(total),
      windowDays: SENTRY_WINDOW_DAYS,
    });
  } catch {
    return { reason: "sentry_malformed", status: "unavailable" };
  }
}

/** Best-effort user-scoped error signals; no request is made unless the org slug and binding are configured. */
async function readUserErrors(
  ctx: ProviderContext,
  scope: WidgetContext
): Promise<z.infer<typeof userErrorSignals>> {
  const slug = sentryOrgSlug.safeParse(process.env.WIDGET_SENTRY_ORG_SLUG);
  let path: string;
  try {
    path = operationPath("sentry.searchIssues");
  } catch {
    return { reason: "sentry_unconfigured", status: "unavailable" };
  }
  if (!slug.success) {
    return { reason: "sentry_unconfigured", status: "unavailable" };
  }
  try {
    const outcome = await invokeProvider(
      ctx,
      path,
      // A validated UUID cannot break the Sentry query DSL. Bounded to this user's errors.
      {
        organizationSlug: slug.data,
        query: `is:unresolved level:error user.id:"${scope.userId}" lastSeen:-${SENTRY_WINDOW_DAYS}d`,
      },
      undefined,
      { maxBytes: 64 * 1024, timeoutMs: 20_000 }
    );
    if (!outcome.ok || (outcome.http && outcome.http.status !== 200)) {
      return { reason: "sentry_unreachable", status: "unavailable" };
    }
    return parseSentryUserErrors(outcome.data);
  } catch {
    return { reason: "sentry_unreachable", status: "unavailable" };
  }
}

/** No selector: the verified user and workspace fully determine this read. */
export async function readWidgetAccountAccess(
  ctx: ProviderContext
): Promise<WidgetAccountAccessOutput> {
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  const query = buildAccountAccessQuery(scope);
  let stage = "configuration";
  try {
    ctx.abortSignal.throwIfAborted();
    const path = operationPath("planetscale.readQuery");
    if (
      path !==
      "planetscale.org.foremanPlanetscale.planetscale_execute_read_query"
    ) {
      throw new Error("Unexpected evidence operation binding.");
    }
    stage = "transport";
    const result = await invokeProvider(
      ctx,
      path,
      { ...PRODUCTION_READ_QUERY_ARGS, query, use_replica: false },
      undefined,
      { maxBytes: 128 * 1024, timeoutMs: 50_000 }
    );
    if (!result.ok || (result.http && result.http.status !== 200)) {
      throw new Error("Evidence provider unavailable.");
    }
    stage = "response";
    const parsed = parseAccountAccess(result.data, scope, {
      reason: "sentry_unconfigured",
      status: "unavailable",
    });
    // Sentry is additive and only read once membership is authorized; its own failure degrades inside userErrorSignals.
    if (parsed.status === "ok") {
      parsed.userErrorSignals = await readUserErrors(ctx, scope);
    }
    return parsed;
  } catch (error) {
    if (ctx.abortSignal.aborted) {
      throw error;
    }
    // Parser and provider errors may carry customer rows or credentials. Never forward them.
    logOpsEvent(
      "widget.support.account_access.failed",
      {
        code: stage,
        outcome: "error",
        tool: "widget_account_access",
      },
      console.warn
    );
    return {
      message:
        "Account and access state could not be checked. This is not an empty result; no field in it should be read as empty.",
      status: "unavailable",
    };
  }
}

const tool = defineTool({
  description:
    "Diagnose login, access and onboarding problems only for the verified user in this chat's workspace. Returns that user's membership and role, whether their seat is active, the workspace's status, partner and used seat count by role, the plan seat limit (from billing, not read here), the onboarding steps done versus pending, this workspace's pending invitations (with the invited email so an invite-login report can be matched), and, when Sentry is configured and reachable, sanitized counts of all unresolved errors recorded for that user in the last 14 days (any product area; not proof of a sign-in failure). Support-safe status and dates only, never a password hash, session or token, and never another member's email. Saved state, not a live auth or billing check. Unavailable is not empty. No SQL, workspace, user or field selector is accepted.",
  execute: async (_input, ctx: ToolContext) => readWidgetAccountAccess(ctx),
  inputSchema: widgetAccountAccessInput,
  outputSchema: widgetAccountAccessOutput,
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) ? tool : null,
  },
});
