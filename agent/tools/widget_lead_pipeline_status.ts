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

const SCRAPE_RUN_LIMIT = 20;
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 90;
// ponytail: a run older than this in a non-terminal status is called stuck; a
// fixed threshold, not per-source SLAs. The live run cannot be read in the widget lane.
const STUCK_MINUTES = 30;

export const widgetLeadPipelineInput = z.strictObject({
  campaignId: z.uuid().optional(),
  scrapeRunId: z.uuid().optional(),
  sinceDays: z.number().int().min(1).max(MAX_WINDOW_DAYS).optional(),
});
export type WidgetLeadPipelineInput = z.infer<typeof widgetLeadPipelineInput>;

const count = z.number().int().nonnegative();
const total = z.number().int();
const timestamp = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));
const scrapeStatus = z.enum(["pending", "running", "completed", "failed"]);
const scrapeSource = z.enum([
  "apollo",
  "apify",
  "ampleleads",
  "scrappio",
  "leadfeeder",
  "instantly",
  "manual",
]);
const scrapeAction = z.enum(["none", "upload_to_campaign", "complete"]);

const verificationJobs = z.object({
  completed: count,
  failed: count,
  pending: count,
  unknown: count,
});
const scrapeRun = z.object({
  action: scrapeAction.nullable(),
  campaignId: z.uuid().nullable(),
  // Run's own tally; compare with storedLeadCount before trusting it.
  declaredLeadCount: count.nullable(),
  finishedAt: timestamp.nullable(),
  id: z.uuid(),
  name: z.string().max(300).nullable(),
  // Source-provider run ID; for manual uploads this is a submission ID, never an established Inngest run ID.
  runId: z.string().max(200).nullable(),
  source: scrapeSource,
  startedAt: timestamp.nullable(),
  status: scrapeStatus,
  storedLeadCount: count,
  stuck: z.boolean(),
  unverifiedLeadCount: count,
  updatedAt: timestamp,
  verificationJobs,
  verifiedLeadCount: count,
});
const importActivity = z.object({
  campaignLeadCount: count,
  campaignsWithLeads: count,
  // Signed: usage rows may store deductions as negatives.
  ingestionCreditsUsed: total,
  ingestionCreditTransactions: count,
});
const reconciliation = z.object({
  campaignLeadStoredTotal: count,
  // True when the runs' declared totals and the persisted scrape leads disagree.
  discrepancy: z.boolean(),
  note: z.string().max(300),
  scrapeLeadStoredTotal: count,
  scrapeRunDeclaredTotal: count,
});

export const widgetLeadPipelineOutput = z.union([
  z.object({
    caveats: z.array(z.string()).max(6),
    importActivity,
    observedAt: timestamp,
    reconciliation,
    scrapeRuns: z.array(scrapeRun).max(SCRAPE_RUN_LIMIT),
    source: z.literal(
      "Acquisity product database; saved state, not a live scraper or provider check"
    ),
    status: z.literal("ok"),
    windowDays: z.number().int().min(1).max(MAX_WINDOW_DAYS),
    workspace: z.string().max(500),
  }),
  z.object({
    message: z.string(),
    status: z.enum(["unavailable", "denied"]),
  }),
]);
export type WidgetLeadPipelineOutput = z.infer<typeof widgetLeadPipelineOutput>;

/** Fixed statements only; every product join hangs off the authorized workspace. */
export function buildWidgetLeadPipelineQuery(
  context: WidgetContext,
  raw: WidgetLeadPipelineInput
): string {
  const scope = widgetContextSchema.parse(context);
  const input = widgetLeadPipelineInput.parse(raw);
  const days = input.sinceDays ?? DEFAULT_WINDOW_DAYS;
  const authorization = `with authorized as (
    select o.id from organization o join member m on m.organization_id = o.id
    where o.id = '${scope.organizationId}'::uuid and m.user_id = '${scope.userId}'::uuid
      and o.deleted_at is null and m.deleted_at is null and m.role in ('owner', 'admin')
      and (o.partner_id is null or o.partner_id = '${scope.partnerId}'::uuid)
  )`;
  const selectedRun = input.scrapeRunId
    ? `and lsr.id = '${input.scrapeRunId}'::uuid`
    : "";
  const selectedCampaign = input.campaignId
    ? `and lsr.campaign_id = '${input.campaignId}'::uuid
    and exists (select 1 from outreach_campaign c where c.id = lsr.campaign_id and c.organization_id = lsr.organization_id)`
    : "";
  const scrapeRuns = `select lsr.id, left(lsr.name, 300) as name, lsr.campaign_id as "campaignId", lsr.status, lsr.source, lsr.action,
      lsr.run_id as "runId", lsr.lead_count as "declaredLeadCount",
      (select count(*) from lead_scrape_lead lsl
        where lsl.organization_id = lsr.organization_id and lsl.scrape_run_id = lsr.id) as "storedLeadCount",
      (select count(*) from lead_scrape_lead lsl
        where lsl.organization_id = lsr.organization_id and lsl.scrape_run_id = lsr.id
          and (lsr.source = 'instantly' or lsl.is_email_verified = true)) as "verifiedLeadCount",
      (select count(*) from lead_scrape_lead lsl
        where lsl.organization_id = lsr.organization_id and lsl.scrape_run_id = lsr.id
          and lsr.source is distinct from 'instantly' and lsl.is_email_verified is not true) as "unverifiedLeadCount",
      (select jsonb_build_object(
        'pending', count(*) filter (where v.status = 'pending'),
        'completed', count(*) filter (where v.status = 'completed'),
        'failed', count(*) filter (where v.status = 'failed'),
        'unknown', count(*) filter (where v.status is null or v.status not in ('pending', 'completed', 'failed')))
        from lead_scrape_email_verification v
        where v.organization_id = lsr.organization_id and v.scrape_run_id = lsr.id) as "verificationJobs",
      (lsr.status in ('pending', 'running')
        and lsr.started_at < current_timestamp - interval '${STUCK_MINUTES} minutes') as stuck,
      lsr.started_at as "startedAt", lsr.finished_at as "finishedAt", lsr.updated_at as "updatedAt"
    from lead_scrape_run lsr join authorized a on a.id = lsr.organization_id
    where ${input.scrapeRunId ? "true" : `lsr.created_at > current_timestamp - make_interval(days => ${days})`}
    ${selectedRun} ${selectedCampaign}
    order by lsr.created_at desc, lsr.id desc limit ${SCRAPE_RUN_LIMIT}`;
  const importActivityJson = `(select to_jsonb(i) from (
    select
      (select count(distinct ocl.campaign_id) from outreach_campaign_lead ocl
        join authorized a on a.id = ocl.organization_id where ocl.deleted_at is null) as "campaignsWithLeads",
      (select count(*) from outreach_campaign_lead ocl
        join authorized a on a.id = ocl.organization_id where ocl.deleted_at is null) as "campaignLeadCount",
      (select count(*) from credit_transaction ct
        join authorized a on a.id = ct.organization_id
        where ct.type = 'usage' and ct.reference_type in ('campaign_lead_ingestion', 'outreach_lead_capacity')
          and ct.created_at > current_timestamp - make_interval(days => ${days})) as "ingestionCreditTransactions",
      coalesce((select sum(ct.amount) from credit_transaction ct
        join authorized a on a.id = ct.organization_id
        where ct.type = 'usage' and ct.reference_type in ('campaign_lead_ingestion', 'outreach_lead_capacity')
          and ct.created_at > current_timestamp - make_interval(days => ${days})), 0) as "ingestionCreditsUsed"
  ) i)`;
  const reconciliationJson = `(select to_jsonb(rc) from (
    select
      coalesce((select sum(lsr.lead_count) from lead_scrape_run lsr
        join authorized a on a.id = lsr.organization_id), 0) as "scrapeRunDeclaredTotal",
      (select count(*) from lead_scrape_lead lsl
        join authorized a on a.id = lsl.organization_id) as "scrapeLeadStoredTotal",
      (select count(*) from outreach_campaign_lead ocl
        join authorized a on a.id = ocl.organization_id where ocl.deleted_at is null) as "campaignLeadStoredTotal"
  ) rc)`;
  // One statement checks current permissions and reads evidence in the same snapshot.
  return `${authorization}
    select (select count(*) = 1 from authorized) as authorized,
      current_timestamp as "observedAt",
      coalesce((select jsonb_agg(to_jsonb(r)) from (${scrapeRuns}) r), '[]'::jsonb) as "scrapeRuns",
      ${importActivityJson} as "importActivity",
      ${reconciliationJson} as reconciliation`;
}

const CAVEATS = [
  "Saved product state is not a live scraper, verification or Inngest run check.",
  "declaredLeadCount is the run's tally; storedLeadCount counts persisted rows. A difference in either direction is a count discrepancy, not proof that scraping or verification failed or never finished. verifiedLeadCount follows Acquisity: all Instantly-sourced rows count as verified; other sources require is_email_verified.",
  "A stuck run is inferred from status and age, not confirmed. runId is a source-provider reference, or a submission ID for manual uploads; it is not an established Inngest run ID. widget_job_failures lists recorded failures. A scrapeRunId selects that owned run regardless of age; campaignId filters runs within the date window. Import activity and reconciliation remain workspace-wide.",
  "ingestionCreditsUsed covers campaign lead ingestion and lead-capacity reservations, not scrape runs, so compare it against stored leads to explain 'credits used but no leads'.",
  "The dashboard 'Leads Uploaded' counter is a separate accounting metric; campaignLeadStoredTotal is the true count of leads in campaigns.",
  "verificationJobs counts saved verification jobs by status, not individual email verdicts. unverifiedLeadCount follows the same source-specific product rule as verifiedLeadCount; it does not mean those addresses are invalid. Import step details and campaign launch gating are not established by these counts.",
];

/** Parse only the provider envelope and declared fields; never forward raw failure bodies. */
export function parseWidgetLeadPipelineEvidence(
  data: unknown,
  context: WidgetContext,
  input: WidgetLeadPipelineInput
): WidgetLeadPipelineOutput {
  const envelope = z
    .object({
      rows: z
        .array(
          z.object({
            authorized: z.boolean(),
            importActivity: z.unknown(),
            observedAt: timestamp,
            reconciliation: z.unknown(),
            scrapeRuns: z.array(z.unknown()).max(SCRAPE_RUN_LIMIT),
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
      message: "Current workspace access could not be verified.",
      status: "denied",
    };
  }
  const runs = z
    .array(scrapeRun)
    .max(SCRAPE_RUN_LIMIT)
    .parse(result.scrapeRuns);
  const activity = importActivity.parse(result.importActivity);
  const totals = reconciliation
    .omit({ discrepancy: true, note: true })
    .parse(result.reconciliation);
  const discrepancy =
    totals.scrapeRunDeclaredTotal !== totals.scrapeLeadStoredTotal;
  return widgetLeadPipelineOutput.parse({
    caveats: CAVEATS,
    importActivity: activity,
    observedAt: result.observedAt,
    reconciliation: {
      ...totals,
      discrepancy,
      note: discrepancy
        ? "Declared totals and persisted rows differ. This does not establish a processing failure or its cause; assess recorded run status and failures separately."
        : "Declared run totals reconcile with persisted scrape leads; a low dashboard 'Leads Uploaded' figure is an accounting metric, not a missing-leads fact.",
    },
    scrapeRuns: runs,
    source:
      "Acquisity product database; saved state, not a live scraper or provider check",
    status: "ok",
    windowDays: input.sinceDays ?? DEFAULT_WINDOW_DAYS,
    workspace: context.organizationName,
  });
}

/** Widget reads accept owned scrape/campaign IDs and a bounded window, never workspace or SQL. */
export async function readWidgetLeadPipelineStatus(
  ctx: ProviderContext,
  input: WidgetLeadPipelineInput
): Promise<WidgetLeadPipelineOutput> {
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  const query = buildWidgetLeadPipelineQuery(scope, input);
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
    return parseWidgetLeadPipelineEvidence(result.data, scope, input);
  } catch (error) {
    if (ctx.abortSignal.aborted) {
      throw error;
    }
    // Parser and provider errors may contain customer rows or credentials. Never forward them.
    logOpsEvent(
      "widget.support.lead_pipeline_status.failed",
      {
        code: stage,
        outcome: "error",
        tool: "widget_lead_pipeline_status",
      },
      console.warn
    );
    return {
      message:
        "Lead scraping and import state could not be checked. This is not an empty result; no count in it should be read as zero.",
      status: "unavailable",
    };
  }
}

const tool = defineTool({
  description:
    "Diagnose lead scraping and CSV import problems only in this chat's verified workspace. Returns the last 20 lead-scrape runs (status, source, action, source-provider runId (manual uploads use a submission ID), run name, campaignId, saved verification-job status counts, unverified count, the run's declared lead count versus leads actually stored, verified leads, a stuck flag, and start/finish times), an import-activity summary (campaigns with leads, total campaign leads, and lead-ingestion credit transactions and credits used in the window), and a lead-count reconciliation (declared scrape totals versus persisted scrape leads versus campaign leads, with a discrepancy flag) so a low dashboard 'Leads Uploaded' figure or vanished leads can be explained. Optional scrapeRunId selects one owned run even outside the date window; campaignId narrows the recent runs to an owned campaign. Optional sinceDays (1-90, default 30) bounds the scrape-run and credit window; reconciliation totals span all time. Saved state, not a live scraper check; the live run trace and CSV import step detail cannot be read here, and runId is not a proven Inngest run ID. Import activity and reconciliation remain workspace-wide even when runs are filtered. Unavailable is not empty. No SQL, workspace or field selector is accepted.",
  execute: async (input, ctx: ToolContext) =>
    readWidgetLeadPipelineStatus(ctx, input),
  inputSchema: widgetLeadPipelineInput,
  outputSchema: widgetLeadPipelineOutput,
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) ? tool : null,
  },
});
