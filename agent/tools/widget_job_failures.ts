import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { executorClient } from "#lib/executor/client.js";
import type { ProviderContext } from "#lib/executor/dispatch.js";
import {
  type FindFunctionRunsResult,
  findFunctionRuns,
  type RunStatus,
} from "#lib/inngest-api.js";
import { logOpsEvent } from "#lib/ops-log.js";
import { isWidgetSupport, requireWidgetContext } from "#lib/widget-scope.js";

const SINCE_HOURS = 24;
const STATUSES = ["Failed", "Cancelled"] as const;
const MAX_TARGETED_LOOKUPS = 2;

const AREAS = [
  "campaign_dispatch",
  "provisioning",
  "ai_sdr",
  "scrape",
  "import",
] as const;
type Area = (typeof AREAS)[number];

/**
 * Inngest function ids are static per code path, never per org, so a name
 * match only buckets a run into a likely product area for display; it is
 * never an ownership or org-scoping check.
 */
const AREA_PATTERNS: Record<Area, RegExp> = {
  ai_sdr: /ai[-_]?sdr/i,
  campaign_dispatch: /campaign|outreach|dispatch|instantly|email-?bison/i,
  import: /import|csv/i,
  provisioning: /provision/i,
  scrape: /scrape|lead-?source|discovery/i,
};

function classify(
  functionId: string | null,
  functionName: string | null
): Area | null {
  const label = `${functionId ?? ""} ${functionName ?? ""}`;
  return AREAS.find((area) => AREA_PATTERNS[area].test(label)) ?? null;
}

export const widgetJobFailuresInput = z.strictObject({
  area: z.enum(AREAS).optional(),
});
export type WidgetJobFailuresInput = z.infer<typeof widgetJobFailuresInput>;

const timestamp = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));
/**
 * No entity id: `findFunctionRuns` already replaces every id-shaped token in
 * step error text with `[id]` before this tool ever sees it (the same
 * redaction customer-facing evidence tools rely on elsewhere), so a run can
 * never be tied back to one workspace's own record from this data alone.
 * This is an aggregate infra signal, not a per-workspace finding; pair it
 * with the area's own evidence tool (for example widget_outreach_health or
 * widget_sdr_thread_status) to confirm this workspace was actually affected.
 */
const areaFinding = z.object({
  errorSummary: z.string().max(500),
  functionName: z.string().max(200),
  status: z.enum(["failed", "stuck"]),
  timestamp,
});
const findingsByArea = z.object({
  ai_sdr: areaFinding.nullable(),
  campaign_dispatch: areaFinding.nullable(),
  import: areaFinding.nullable(),
  provisioning: areaFinding.nullable(),
  scrape: areaFinding.nullable(),
});
export const widgetJobFailuresOutput = z.union([
  z.object({
    caveats: z.array(z.string()).max(6),
    findingsByArea,
    observedAt: timestamp,
    source: z.literal("Inngest run history (not this workspace's own data)"),
    status: z.literal("ok"),
  }),
  z.object({
    message: z.string(),
    status: z.literal("unavailable"),
  }),
]);
export type WidgetJobFailuresOutput = z.infer<typeof widgetJobFailuresOutput>;

function findingFrom(
  result: FindFunctionRunsResult,
  status: RunStatus,
  wantedArea: Area | undefined
): { area: Area; finding: z.infer<typeof areaFinding> } | null {
  const newest = result.latestTrace
    ? result.runs.find((run) => run.runId === result.latestTrace?.runId)
    : undefined;
  if (!(newest && result.latestTrace)) {
    return null;
  }
  const area = classify(newest.functionId, newest.functionName);
  if (!area || (wantedArea && area !== wantedArea)) {
    return null;
  }
  const time = newest.startedAt ?? newest.queuedAt ?? newest.endedAt;
  if (!time) {
    return null;
  }
  const errorSummary =
    result.latestTrace.steps.find((step) => step.error)?.error ?? "";
  return {
    area,
    finding: {
      errorSummary,
      functionName: newest.functionName ?? newest.functionId ?? "unknown",
      status: status === "Cancelled" ? "stuck" : "failed",
      timestamp: time,
    },
  };
}

const CAVEATS = [
  "This checks whether the background job TYPE is currently failing or cancelled anywhere, not whether this workspace's own data was affected; confirm with the matching area evidence tool.",
  "Only the newest matching run per function is inspected, not every failure in the window; a quiet area may still have older failures.",
  "Area is inferred from the function's name, not a guaranteed mapping.",
  "'stuck' approximates a cancelled run; Inngest's live in-progress state is not exposed here.",
];

/**
 * Widget-scoped cross-cutting job-health check: is a background job type
 * (campaign dispatch, provisioning, AI SDR, lead scrape, import) currently
 * failing or getting cancelled, anywhere. This is deliberately NOT tied to
 * one workspace's own entity: `findFunctionRuns` already strips every
 * id-shaped token from step error text before it reaches this tool, so a run
 * can never be verified as this workspace's; area-specific evidence tools
 * own that attribution.
 *
 * ponytail: only the free trace from each discovery call, plus up to
 * MAX_TARGETED_LOOKUPS function-scoped lookups when an area is requested, are
 * inspected. Raise MAX_TARGETED_LOOKUPS if the widget needs denser coverage
 * than the newest run per function.
 */
export async function readWidgetJobFailures(
  ctx: ProviderContext,
  input: WidgetJobFailuresInput
): Promise<WidgetJobFailuresOutput> {
  requireWidgetContext(ctx.session?.auth.initiator);
  let stage = "discovery";
  try {
    const client = executorClient(ctx);
    const discovery = await Promise.all(
      STATUSES.map((status) =>
        findFunctionRuns(
          { sinceHours: SINCE_HOURS, status },
          { client, signal: ctx.abortSignal }
        )
      )
    );
    if (discovery.every((result) => result.error !== undefined)) {
      throw new Error("Inngest run history is unavailable.");
    }

    const findings = discovery
      .map((result, index) => findingFrom(result, STATUSES[index], input.area))
      .filter((found): found is NonNullable<typeof found> => found !== null);

    if (input.area) {
      stage = "targeted";
      const alreadyCovered = new Set(findings.map((found) => found.area));
      const targets = discovery
        .flatMap((result, index) =>
          result.runs
            .filter(
              (run) =>
                run.functionId &&
                classify(run.functionId, run.functionName) === input.area
            )
            .map((run) => ({
              functionId: run.functionId as string,
              status: STATUSES[index],
            }))
        )
        .filter(
          (target, index, all) =>
            all.findIndex(
              (other) =>
                other.functionId === target.functionId &&
                other.status === target.status
            ) === index
        )
        .slice(0, MAX_TARGETED_LOOKUPS);
      const targeted = await Promise.all(
        targets.map((target) =>
          findFunctionRuns(
            {
              functionId: target.functionId,
              sinceHours: SINCE_HOURS,
              status: target.status,
            },
            { client, signal: ctx.abortSignal }
          )
        )
      );
      for (const [index, result] of targeted.entries()) {
        if (alreadyCovered.has(input.area)) {
          break;
        }
        const found = findingFrom(result, targets[index].status, input.area);
        if (found) {
          findings.push(found);
          alreadyCovered.add(found.area);
        }
      }
    }

    const byArea: Record<Area, z.infer<typeof areaFinding> | null> = {
      ai_sdr: null,
      campaign_dispatch: null,
      import: null,
      provisioning: null,
      scrape: null,
    };
    for (const found of findings) {
      byArea[found.area] ??= found.finding;
    }

    const caveats = [...CAVEATS];
    if (discovery.some((result) => result.error !== undefined)) {
      caveats.push(
        "Part of this window's run history could not be read; treat gaps as unchecked, not clean."
      );
    }

    return widgetJobFailuresOutput.parse({
      caveats,
      findingsByArea: byArea,
      observedAt: new Date().toISOString(),
      source: "Inngest run history (not this workspace's own data)",
      status: "ok",
    });
  } catch (error) {
    if (ctx.abortSignal.aborted) {
      throw error;
    }
    logOpsEvent(
      "widget.support.job_failures.failed",
      { code: stage, outcome: "error", tool: "widget_job_failures" },
      console.warn
    );
    return {
      message:
        "Background job history could not be checked. This is not an empty result; no area in it should be read as failure-free.",
      status: "unavailable",
    };
  }
}

const tool = defineTool({
  description:
    "Cross-cutting check for whether a background job TYPE is currently failing or getting cancelled anywhere, when something 'didn't run', an import failed, provisioning looks stuck, or sends aren't firing. Areas: campaign_dispatch, provisioning, ai_sdr, scrape, import. Without area: a quick sweep of the newest failed and cancelled run overall. With area: also looks at that area's own recent function history. Each finding has the function/area, status (failed or stuck), a sanitized error summary (ids are already replaced with [id]), and a timestamp. This is an aggregate infra signal, NOT proof this workspace's own data was affected; pair it with the matching area evidence tool (for example widget_outreach_health or widget_sdr_thread_status) to confirm. Unavailable is not empty.",
  execute: async (input, ctx: ToolContext) => readWidgetJobFailures(ctx, input),
  inputSchema: widgetJobFailuresInput,
  outputSchema: widgetJobFailuresOutput,
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) ? tool : null,
  },
});
