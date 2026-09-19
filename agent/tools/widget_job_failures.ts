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

const FAILURE_LIMIT = 25;

// Areas the product DB records a per-org failure state for. campaign_dispatch
// and import are intentionally absent: campaign "not sending" state is owned by
// widget_outreach_health, and lead-import step failure lives only in the Inngest
// run (no org-scoped product row), so this tool would have to fabricate it.
const AREAS = ["ai_sdr", "provisioning", "scrape"] as const;
type Area = (typeof AREAS)[number];

const SINCE = { "7d": 7, "24h": 1, "30d": 30 } as const;

export const widgetJobFailuresInput = z.strictObject({
  area: z.enum(AREAS).optional(),
  since: z.enum(["24h", "7d", "30d"]).optional(),
});
export type WidgetJobFailuresInput = z.infer<typeof widgetJobFailuresInput>;

const timestamp = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));

// entityId is one of the org's OWN record ids (safe to surface). inngestRunId is
// present only where the product row stores it (scrape), so a teammate can pull
// the raw run via find_function_runs. Error TEXT is never returned — only hasError.
const failure = z.object({
  area: z.enum(AREAS),
  entityId: z.string().max(128),
  entityType: z.string().max(64),
  hasError: z.boolean(),
  inngestRunId: z.string().max(191).nullable(),
  observedAt: timestamp,
  status: z.enum(["failed", "requires_attention"]),
});

const widgetJobFailuresOutput = z.union([
  z.object({
    caveats: z.array(z.string().max(300)).max(6),
    coveredAreas: z.array(z.enum(AREAS)),
    failures: z.array(failure).max(FAILURE_LIMIT),
    observedAt: timestamp,
    source: z.string().max(300),
    status: z.literal("ok"),
    truncated: z.boolean(),
    workspace: z.string().max(500),
  }),
  z.object({
    message: z.string().max(300),
    status: z.enum(["unavailable", "denied"]),
  }),
]);
export type WidgetJobFailuresOutput = z.infer<typeof widgetJobFailuresOutput>;

/** Fixed statements only; every area subquery hangs off the authorized workspace. */
export function buildQuery(
  context: WidgetContext,
  input: WidgetJobFailuresInput
) {
  const scope = widgetContextSchema.parse(context);
  const days = SINCE[input.since ?? "7d"];
  const areas = input.area ? [input.area] : [...AREAS];
  const authorization = `with authorized as (
    select o.id, o.name
    from organization o join member m on m.organization_id = o.id
    where o.id = '${scope.organizationId}'::uuid
      and m.user_id = '${scope.userId}'::uuid
      and m.role in ('owner','admin')
      and o.deleted_at is null and m.deleted_at is null
    limit 1)`;

  // Each subquery is org-scoped through `authorized`; errors are reduced to a
  // boolean so no raw provider/customer text leaves SQL.
  const parts: Record<Area, string> = {
    ai_sdr: `select 'ai_sdr' as area, 'agent_execution' as entity_type,
        e.id::text as entity_id, e.execution_run_id::text as inngest_run_id,
        'failed' as status, (e.error is not null) as has_error,
        e.started_at as observed_at
      from agent_executions e join authorized a on a.id = e.organization_id
      where e.success = false and e.started_at > now() - interval '${days} days'`,
    provisioning: `select 'provisioning' as area, 'domain_purchase_order' as entity_type,
        o.id::text as entity_id, null::text as inngest_run_id,
        o.status as status, (o.error is not null or o.error_details is not null) as has_error,
        o.updated_at as observed_at
      from domain_purchase_order o join authorized a on a.id = o.organization_id
      where o.status in ('failed','requires_attention')
        and o.updated_at > now() - interval '${days} days'`,
    scrape: `select 'scrape' as area, 'lead_scrape_run' as entity_type,
        r.id::text as entity_id, r.run_id as inngest_run_id,
        'failed' as status, false as has_error,
        r.created_at as observed_at
      from lead_scrape_run r join authorized a on a.id = r.organization_id
      where r.status = 'failed' and r.created_at > now() - interval '${days} days'`,
  };

  const union = areas.map((area) => parts[area]).join("\nunion all\n");
  return `${authorization}
    select (select count(*) = 1 from authorized) as authorized,
      (select name from authorized) as workspace,
      coalesce((select json_agg(f) from (
        ${union}
        order by observed_at desc
        limit ${FAILURE_LIMIT + 1}
      ) f), '[]'::json) as failures`;
}

const rowSchema = z.object({
  authorized: z.boolean(),
  failures: z
    .array(
      z.object({
        area: z.enum(AREAS),
        entity_id: z.string(),
        entity_type: z.string(),
        has_error: z.boolean(),
        inngest_run_id: z.string().nullable(),
        observed_at: z.string(),
        status: z.string(),
      })
    )
    .nullable(),
  workspace: z.string().nullable(),
});

const mapStatus = (raw: string): "failed" | "requires_attention" =>
  raw === "requires_attention" ? "requires_attention" : "failed";

export async function readWidgetJobFailures(
  ctx: ProviderContext,
  input: WidgetJobFailuresInput
): Promise<WidgetJobFailuresOutput> {
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  try {
    ctx.abortSignal.throwIfAborted();
    const query = buildQuery(scope, input);
    const path = operationPath("planetscale.readQuery");
    const provided = await invokeProvider(
      ctx,
      path,
      { ...PRODUCTION_READ_QUERY_ARGS, query, use_replica: false },
      undefined,
      { maxBytes: 128 * 1024, timeoutMs: 50_000 }
    );
    if (!provided.ok || (provided.http && provided.http.status !== 200)) {
      throw new Error("Evidence provider unavailable.");
    }
    const [result] = z
      .object({ rows: z.array(rowSchema).min(1) })
      .parse(providerData(provided.data)).rows;
    if (!(result.authorized && result.workspace)) {
      return {
        message: "Workspace access could not be verified.",
        status: "denied",
      };
    }
    const rows = (result.failures ?? []).slice(0, FAILURE_LIMIT);
    const covered = input.area ? [input.area] : [...AREAS];
    const caveats = [
      "Campaign sending problems are covered by widget_outreach_health.",
      "CSV-import step detail is only in the Inngest run; use find_function_runs.",
      "inngestRunId is present only for scrape runs; drill in with find_function_runs.",
    ];
    return {
      caveats,
      coveredAreas: covered,
      failures: rows.map((r) => ({
        area: r.area,
        entityId: r.entity_id.slice(0, 128),
        entityType: r.entity_type.slice(0, 64),
        hasError: r.has_error,
        inngestRunId: r.inngest_run_id,
        observedAt: r.observed_at,
        status: mapStatus(r.status),
      })),
      observedAt: new Date().toISOString(),
      source:
        "Acquisity product database; per-org failed job records, not a live Inngest run scan.",
      status: "ok",
      truncated: (result.failures ?? []).length > FAILURE_LIMIT,
      workspace: result.workspace,
    };
  } catch (error) {
    logOpsEvent(
      "widget.job_failures.unavailable",
      { outcome: "error" },
      console.warn
    );
    if (ctx.abortSignal.aborted) {
      throw error;
    }
    return {
      message: "The job-failure records could not be read for this workspace.",
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
    "This workspace's recent FAILED background jobs, org-scoped: AI SDR agent runs, domain/inbox provisioning orders, and lead-scrape runs. " +
    "Each failure carries the org's own entity id, a failed/requires_attention status, whether it recorded an error, and (scrape only) the Inngest run id to drill in with find_function_runs. " +
    "Campaign-send problems use widget_outreach_health; import step detail is Inngest-only. unavailable means the records could not be read, distinct from an empty (no failures) result.",
  execute: (input, ctx) => readWidgetJobFailures(ctx, input),
  inputSchema: widgetJobFailuresInput,
  outputSchema: widgetJobFailuresOutput,
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) ? tool : null,
  },
});
