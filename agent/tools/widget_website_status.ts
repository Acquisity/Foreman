import type { ToolContext } from "eve/tools";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { readWidgetOwnership } from "#lib/executor/dispatch.js";
import { logOpsEvent } from "#lib/ops-log.js";
import { providerData } from "#lib/support/conversation.js";
import {
  isWidgetSupport,
  requireWidgetContext,
  type WidgetContext,
  widgetContextSchema,
} from "#lib/widget-scope.js";
import { type Fetch, readVercelLive } from "#lib/widget-vercel.js";

/**
 * Structured evidence for Website / Funnel Builder failures in the widget lane.
 * Answers: publish/build failed, a connected custom domain 404s because the
 * project never published, preview blank, or a wrong domain is still attached.
 * ponytail: one bounded list read, no per-project detail selector and no cursor
 * paging — the list already carries every field support needs; add a projectId
 * read only if a real chat needs deeper history than 30 recent projects give.
 */

const PROJECT_PAGE_SIZE = 30;
const FAILURE_REASON_LIMIT = 500;
const NAME_SQL_LIMIT = 300;
const DOMAIN_LIMIT = 20;
// Live provider checks cost several requests each, so only the most recently
// updated projects get one; the rest keep their saved state.
const LIVE_PROJECT_LIMIT = 3;

// Empty object: the read is fully scoped by the verified session; no selectors,
// no SQL, no workspace/project override are accepted from the model.
const inputSchema = z.strictObject({});

const timestamp = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));

const domain = z.object({
  // A connected custom domain: legacy website.custom_domain or a purchased website_domain.
  domain: z.string().max(256),
  // Live DNS/registration is not checked here; state is the last saved record.
  state: z.string().max(128).nullable(),
  verified: z.boolean().nullable(),
});

const deployment = z
  .object({
    deploymentId: z.string().max(256).nullable(),
    provider: z.string().max(32),
    state: z.string().max(64),
  })
  .nullable();

const live = z.union([
  z.object({
    deployment: z
      .object({
        createdAt: timestamp.nullable(),
        errorCode: z.string().max(128).nullable(),
        errorMessage: z.string().max(300).nullable(),
        state: z.string().max(64),
        target: z.string().max(32).nullable(),
      })
      .nullable(),
    domains: z
      .array(
        z.object({
          assignedToProject: z.boolean(),
          domain: z.string().max(256),
          misconfigured: z.boolean().nullable(),
          verified: z.boolean().nullable(),
        })
      )
      .max(DOMAIN_LIMIT),
    status: z.literal("live"),
  }),
  z.object({
    status: z.enum([
      "inaccessible",
      "unavailable",
      "not_linked",
      "not_checked",
    ]),
  }),
]);

const project = z.object({
  // Whether the project has EVER reached a live deployment. false + a connected
  // domain is the usual 404 cause: never published. false is distinct from a
  // failed current build on a project that did publish before.
  currentStatus: z.string().max(64),
  domains: z.array(domain).max(DOMAIN_LIMIT),
  everPublished: z.boolean(),
  id: z.uuid(),
  lastBuildFailureReason: z.string().max(FAILURE_REASON_LIMIT).nullable(),
  lastDeployment: deployment,
  // A live hosting read for this project, kept apart from the saved fields above.
  live,
  // PostgreSQL left(..., 300) counts code points; Zod counts UTF-16 units.
  name: z.string().max(NAME_SQL_LIMIT * 2),
  source: z.enum(["website", "website_project"]),
  updatedAt: timestamp,
});

// The saved row also carries the hosting project id. It selects the live read
// and is dropped before anything reaches the model.
const savedProject = project
  .omit({ live: true })
  .extend({ vercelProjectId: z.string().max(128).nullable().default(null) });

export const widgetWebsiteStatusOutput = z.union([
  z.object({
    caveats: z.array(z.string()).max(6),
    observedAt: timestamp,
    projects: z.array(project).max(PROJECT_PAGE_SIZE),
    source: z.literal(
      "Acquisity product database (saved builder state); each project's live field is a separate hosting read"
    ),
    status: z.literal("ok"),
    truncated: z.boolean(),
    // Domains the workspace bought that are not connected to any website.
    unassignedPurchasedDomains: z.array(domain).max(DOMAIN_LIMIT),
    workspace: z.string().max(500),
  }),
  z.object({
    message: z.string(),
    status: z.enum(["unavailable", "denied"]),
  }),
]);
export type WidgetWebsiteStatusOutput = z.infer<
  typeof widgetWebsiteStatusOutput
>;

/** Connected custom domains for one legacy website id, scoped to the workspace. */
const domainsFor = (
  websiteId: string
) => `coalesce((select jsonb_agg(to_jsonb(dm)) from (
  select w2.custom_domain as domain, w2.domain_verified as verified, null::text as state
  from website w2
  where w2.id = ${websiteId} and w2.organization_id = a.id and w2.deleted_at is null
    and nullif(w2.custom_domain, '') is not null
  union all
  select bd.domain, null::boolean as verified,
    coalesce(bd.cloudflare_registration_status,
      case when bd.vercel_domain_id is not null then 'vercel_connected' else null end) as state
  from website_domain bd
  where bd.website_id = ${websiteId} and bd.organization_id = a.id and bd.status <> 'cancelled'
  limit ${DOMAIN_LIMIT}
) dm), '[]'::jsonb) as domains`;

/**
 * One fixed statement: current membership is re-checked in the same snapshot,
 * so a revoked user reads nothing, and every product join is scoped to the
 * verified organization. New builder (website_project + website_deployment +
 * website_version) and legacy website rows are unioned into one bounded list.
 */
export function buildWidgetWebsiteStatusQuery(context: WidgetContext): string {
  const scope = widgetContextSchema.parse(context);
  const authorization = `with authorized as (
    select o.id from organization o join member m on m.organization_id = o.id
    where o.id = '${scope.organizationId}'::uuid and m.user_id = '${scope.userId}'::uuid
      and o.deleted_at is null and m.deleted_at is null and m.role in ('owner', 'admin')
      and (o.partner_id is null or o.partner_id = '${scope.partnerId}'::uuid)
  )`;
  // v0-backed projects link a legacy website through metadata.legacyWebsiteId;
  // guard the cast so malformed JSON resolves to no linked domains, not an error.
  const legacyWebsiteId = `(case when p.metadata->>'legacyWebsiteId' ~ '^[0-9a-fA-F-]{36}$'
    then (p.metadata->>'legacyWebsiteId')::uuid else null end)`;
  // The hosting id resolves in the app's own order, minus its v0 lookup (no v0
  // access here): the project's column, then its linked legacy website's.
  const projectRows = `select 'website_project' as source, p.id, left(p.name, ${NAME_SQL_LIMIT}) as name,
      p.updated_at as "updatedAt",
      coalesce(nullif(p.vercel_project_id, ''), (select nullif(lw.vercel_project_id, '') from website lw
        where lw.id = ${legacyWebsiteId} and lw.organization_id = a.id and lw.deleted_at is null)) as "vercelProjectId",
      exists(select 1 from website_deployment wd where wd.project_id = p.id
        and wd.organization_id = a.id and wd.deleted_at is null and wd.status = 'deployed') as "everPublished",
      coalesce((select wd.status::text from website_deployment wd
        where wd.project_id = p.id and wd.organization_id = a.id and wd.deleted_at is null
        order by wd.created_at desc, wd.id desc limit 1), 'no_deployment') as "currentStatus",
      left(coalesce(
        (select wd.deployment_error from website_deployment wd
          where wd.project_id = p.id and wd.organization_id = a.id and wd.deleted_at is null
            and nullif(wd.deployment_error, '') is not null
          order by wd.created_at desc, wd.id desc limit 1),
        (select wv.build_error from website_version wv
          join website_chat wc on wc.id = wv.chat_id and wc.organization_id = a.id and wc.project_id = p.id
          where wv.organization_id = a.id and wv.deleted_at is null and nullif(wv.build_error, '') is not null
          order by wv.created_at desc, wv.id desc limit 1)
      ), ${FAILURE_REASON_LIMIT}) as "lastBuildFailureReason",
      (select to_jsonb(x) from (
        select wd.deployment_id as "deploymentId", wd.provider, wd.status as state
        from website_deployment wd
        where wd.project_id = p.id and wd.organization_id = a.id and wd.deleted_at is null
        order by wd.created_at desc, wd.id desc limit 1) x) as "lastDeployment",
      ${domainsFor(legacyWebsiteId)}
    from website_project p join authorized a on a.id = p.organization_id
    where p.deleted_at is null`;
  const websiteRows = `select 'website' as source, w.id, left(w.name, ${NAME_SQL_LIMIT}) as name,
      w.updated_at as "updatedAt", nullif(w.vercel_project_id, '') as "vercelProjectId",
      (w.deployment_url is not null or w.deployment_status = 'deployed') as "everPublished",
      w.deployment_status::text as "currentStatus",
      left(nullif(w.deployment_error, ''), ${FAILURE_REASON_LIMIT}) as "lastBuildFailureReason",
      case when nullif(w.vercel_deployment_id, '') is not null
        then jsonb_build_object('deploymentId', w.vercel_deployment_id, 'provider', 'vercel',
          'state', w.deployment_status::text)
        else null end as "lastDeployment",
      ${domainsFor("w.id")}
    from website w join authorized a on a.id = w.organization_id
    where w.deleted_at is null`;
  const selection = `select * from ((${projectRows}) union all (${websiteRows})) u
    order by u."updatedAt" desc nulls last, u.id desc limit ${PROJECT_PAGE_SIZE + 1}`;
  // One statement checks current permissions and reads evidence in the same snapshot.
  return `${authorization}
    select (select count(*) = 1 from authorized) as authorized,
      current_timestamp as "observedAt",
      coalesce((select jsonb_agg(to_jsonb(r)) from (${selection}) r), '[]'::jsonb) as records,
      coalesce((select jsonb_agg(to_jsonb(ud)) from (
        select bd.domain, null::boolean as verified, bd.cloudflare_registration_status as state
        from website_domain bd join authorized a on a.id = bd.organization_id
        where bd.website_id is null and bd.status <> 'cancelled'
        order by bd.domain limit ${DOMAIN_LIMIT}) ud), '[]'::jsonb) as "unassignedDomains"`;
}

/** Parse only the explicit fields; never forward a raw provider or failure body. */
export function parseWidgetWebsiteStatus(
  data: unknown,
  scope: WidgetContext
): WidgetWebsiteStatusOutput {
  return parseSaved(data, scope).output;
}

function parseSaved(
  data: unknown,
  scope: WidgetContext
): {
  output: WidgetWebsiteStatusOutput;
  projectIds: Map<string, string | null>;
} {
  const envelope = z
    .object({
      // A warning means rows were hidden (e.g. RLS); an incomplete read is never empty.
      rows: z
        .array(
          z.object({
            authorized: z.boolean(),
            observedAt: timestamp,
            records: z.array(z.unknown()).max(PROJECT_PAGE_SIZE + 1),
            unassignedDomains: z.array(domain).max(DOMAIN_LIMIT).default([]),
          })
        )
        .length(1),
      success: z.literal(true),
      warnings: z.array(z.unknown()).max(0).optional(),
    })
    .parse(providerData(data));
  const [result] = envelope.rows;
  if (!result.authorized) {
    return {
      output: {
        message: "Current workspace access could not be verified.",
        status: "denied",
      },
      projectIds: new Map(),
    };
  }
  const rows = z
    .array(savedProject)
    .max(PROJECT_PAGE_SIZE + 1)
    .parse(result.records)
    .slice(0, PROJECT_PAGE_SIZE);
  const output = widgetWebsiteStatusOutput.parse({
    caveats: [
      "Each project's live field is a hosting read made just now; every other field is saved builder state. live.status not_checked, not_linked, inaccessible or unavailable means there is no live result: say the live check was not possible, and answer from saved state.",
      "A READY live deployment does not prove the page renders correctly or that public DNS resolves; misconfigured true means the domain's DNS does not point at hosting.",
      "everPublished false with a connected custom domain is the usual 404 cause: the project never published.",
      "everPublished true with a failed current build means it published before, then broke.",
      "Missing deployment or version rows do not prove a project never built; unavailable is not empty.",
      "Domain verified and state are the last saved record, not a live DNS lookup.",
    ],
    observedAt: result.observedAt,
    projects: rows.map(({ vercelProjectId: _id, ...row }) => ({
      ...row,
      live: { status: "not_checked" },
    })),
    source:
      "Acquisity product database (saved builder state); each project's live field is a separate hosting read",
    status: "ok",
    truncated: result.records.length > PROJECT_PAGE_SIZE,
    unassignedPurchasedDomains: result.unassignedDomains,
    workspace: scope.organizationName,
  });
  return {
    output,
    projectIds: new Map(rows.map((row) => [row.id, row.vercelProjectId])),
  };
}

type StatusContext = Pick<ToolContext, "abortSignal"> &
  Pick<ToolContext, "session">;
type Dispatch = (query: string, signal: AbortSignal) => Promise<unknown>;

/** The verified scope is the only source of the organization read; input is empty. */
export async function readWidgetWebsiteStatus(
  ctx: StatusContext,
  dispatch: Dispatch = readWidgetOwnership,
  fetcher?: Fetch
): Promise<WidgetWebsiteStatusOutput> {
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  const query = buildWidgetWebsiteStatusQuery(scope);
  try {
    ctx.abortSignal.throwIfAborted();
    const data = await dispatch(query, ctx.abortSignal);
    ctx.abortSignal.throwIfAborted();
    const { output, projectIds } = parseSaved(data, scope);
    if (output.status !== "ok") {
      return output;
    }
    // The hosting project id comes from the workspace's own saved row above;
    // readVercelLive never throws except on abort, so saved state always survives.
    const checked = await Promise.all(
      output.projects.slice(0, LIVE_PROJECT_LIMIT).map((row) =>
        readVercelLive(
          projectIds.get(row.id) ?? null,
          row.domains.map((entry) => entry.domain),
          ctx.abortSignal,
          fetcher
        )
      )
    );
    return {
      ...output,
      projects: output.projects.map((row, index) => ({
        ...row,
        live: checked[index] ?? row.live,
      })),
    };
  } catch (error) {
    if (ctx.abortSignal.aborted) {
      throw error;
    }
    // Provider and parser errors may carry customer rows or credentials. Never forward them.
    logOpsEvent(
      "widget.support.website_status.failed",
      { code: "error", outcome: "error", tool: "widget_website_status" },
      console.warn
    );
    return {
      message:
        "Website and funnel builder status could not be checked. This is not an empty result.",
      status: "unavailable",
    };
  }
}

const tool = defineTool({
  description:
    "Read the verified workspace's Website and Funnel Builder projects to explain publish or build failures. Returns up to 30 recent projects with current build status, whether each has EVER successfully published (a connected custom domain plus never-published is the usual cause of a 404), the last build failure reason, connected custom domains with their saved verification/DNS state, the last deployment id and state, and purchased domains not connected to any website (listed apart: bought is not connected). The three most recent projects also carry a read-only live hosting check (latest deployment state and error, whether each saved domain is attached, verified and correctly pointed); everything else is saved product state. Never present saved state as live, and when live is not_checked, inaccessible or unavailable say so. Unavailable is not empty. No SQL, workspace, project id or field selector is accepted.",
  execute: (_input, ctx) => readWidgetWebsiteStatus(ctx),
  inputSchema,
  outputSchema: widgetWebsiteStatusOutput,
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) ? tool : null,
  },
});
