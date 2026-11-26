// Acquisity's support endpoints (ENG-20283) as widget tools. The manifest is
// Acquisity's `serializeForemanManifest()` output, copied into
// widget-endpoint-manifest.ts by scripts/widget-endpoint-tools.ts; each session
// is offered only the endpoints and sections the context route listed for the
// asking user, and the endpoint re-checks that list itself.
import type { SessionAuthContext } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { readContextBody } from "./acquisity-origin.js";
import { logOpsEvent } from "./ops-log.js";
import {
  postWidgetAppRoute,
  type WidgetAppContext,
} from "./widget-app-diagnostics.js";
import { WIDGET_ENDPOINT_MANIFEST } from "./widget-endpoint-manifest.js";
import type {
  AvailableEndpoint,
  EndpointManifest,
  ManifestEndpoint,
} from "./widget-endpoint-schema.js";
import type { CheckId } from "./widget-progress.js";
import {
  isWidgetSupport,
  requireWidgetContext,
  widgetContext,
} from "./widget-scope.js";

/**
 * Areas whose hand-written tool still answers. Each switch PR (ENG-20534 and
 * its siblings) takes its area out of this list, which offers the area's
 * endpoint tool and takes its old tool off the lane (LEGACY_TOOL_AREAS); the
 * old file stays until the cleanup (ENG-20544). An area missing here is
 * offered as soon as the manifest has it.
 */
export const HELD_AREAS: ReadonlySet<string> = new Set<string>();
/**
 * The hand-written widget tools an endpoint area replaces, and the areas each
 * answers for. Job failures reads failed AI SDR runs, provisioning orders and
 * lead scrapes (its AREAS), so it stays until AI SDR, orders and lead
 * pipeline have all switched.
 */
export const LEGACY_TOOL_AREAS: Readonly<Record<string, readonly string[]>> = {
  widget_account_access: ["account"],
  widget_billing_summary: ["billing"],
  widget_generation_diagnostics: ["ai-generation"],
  widget_inbox_health: ["inboxes"],
  widget_job_failures: ["ai-sdr", "lead-pipeline", "orders"],
  widget_lead_pipeline_status: ["lead-pipeline"],
  widget_outreach_health: ["campaigns"],
  widget_provisioning_status: ["orders"],
  widget_sdr_thread_status: ["ai-sdr"],
};

/** A hand-written tool is offered while an area it answers for is held; any other tool is not an area's. */
export const legacyToolOffered = (
  tool: string,
  held: ReadonlySet<string> = HELD_AREAS
) => LEGACY_TOOL_AREAS[tool]?.some((area) => held.has(area)) ?? true;

/**
 * The areas a recorded run had held, read from the tools it called: an area
 * whose own old tool it called was held, one whose endpoint tool it called
 * had switched, and any other area is taken as today's. Job failures answers
 * for three areas and CRM contact's old tool shares its endpoint tool's name,
 * so a call to either shows nothing.
 */
export function heldAreasOfRun(
  tools: readonly string[],
  held: ReadonlySet<string> = HELD_AREAS
): string[] {
  const areas = new Set(held);
  for (const tool of new Set(tools)) {
    const toolAreas = LEGACY_TOOL_AREAS[tool];
    if (toolAreas?.length === 1 && endpointToolName(toolAreas[0]) !== tool) {
      areas.add(toolAreas[0]);
    } else if (!toolAreas && tool.startsWith("widget_")) {
      areas.delete(tool.slice("widget_".length).replaceAll("_", "-"));
    }
  }
  return [...areas].sort();
}

/** Endpoints Foreman's own code calls, never offered to the model. */
export const CODE_ONLY_AREAS: ReadonlySet<string> = new Set([
  "owned-identifiers",
]);

/** The progress check each area reports as; Acquisity's check list is fixed. */
const AREA_CHECKS: Readonly<Record<string, CheckId>> = {
  account: "account",
  "ai-generation": "generation",
  "ai-sdr": "conversations",
  billing: "billing",
  campaigns: "campaigns",
  "crm-contact": "crm",
  inboxes: "inboxes",
  "lead-pipeline": "leads",
  orders: "orders",
  website: "website",
};

/**
 * The endpoint areas a workspace can't use because a feature they require is
 * off (ENG-20514): every version of the area needs at least one of them. Read
 * from the manifest, so a new endpoint or requirement needs no change here.
 */
export const areasOffFor = (
  featuresOff: readonly string[] | undefined,
  manifest: EndpointManifest = WIDGET_ENDPOINT_MANIFEST
): string[] => {
  const off = new Set(featuresOff ?? []);
  const byArea = new Map<string, boolean>();
  for (const entry of manifest.endpoints) {
    if (CODE_ONLY_AREAS.has(entry.name)) {
      continue;
    }
    const blocked = entry.requires.some((feature) => off.has(feature));
    byArea.set(entry.name, (byArea.get(entry.name) ?? true) && blocked);
  }
  return [...byArea].filter(([, blocked]) => blocked).map(([area]) => area);
};

export const endpointToolName = (area: string) =>
  `widget_${area.replaceAll("-", "_")}`;

/** Every tool name the manifest can produce, for the lane's allowlist. */
export const endpointToolNames = (
  manifest: EndpointManifest = WIDGET_ENDPOINT_MANIFEST
): ReadonlySet<string> =>
  new Set(
    manifest.endpoints
      .filter((entry) => !CODE_ONLY_AREAS.has(entry.name))
      .map((entry) => endpointToolName(entry.name))
  );
export const ENDPOINT_TOOL_NAMES = endpointToolNames();

export const endpointToolCheck = (
  toolName: string,
  manifest: EndpointManifest = WIDGET_ENDPOINT_MANIFEST
): CheckId | undefined => {
  const entry = manifest.endpoints.find(
    (candidate) => endpointToolName(candidate.name) === toolName
  );
  return entry ? AREA_CHECKS[entry.name] : undefined;
};

const RESULT_RULES =
  'A result has status "ok" with sections and unavailable. A section named in unavailable could not be read (reason error, timeout or feature_off), which is not the same as empty: say it could not be checked. ' +
  'A value shaped {"diagnosisOnly": true, "value": ...} is for your diagnosis only: never quote or paraphrase it to the customer. ' +
  "Statuses and fields not described here can appear; read them as they are. " +
  "Other statuses: feature_off (the workspace does not have that feature turned on), invalid_input (fix the input and retry once), denied and unavailable (the check could not run).";

function describe(entry: ManifestEndpoint, sections: string[]) {
  const lines = entry.sections
    .filter((section) => sections.includes(section.name))
    .map((section) => {
      const statuses = Object.entries(section.statuses)
        .filter(([, values]) => values.length > 0)
        .map(([field, values]) => ` (${field}: ${values.join(", ")})`)
        .join("");
      return `- ${section.name}: ${section.meaning}${statuses}`;
    });
  return [entry.description, "Sections:", ...lines, RESULT_RULES].join("\n");
}

export interface EndpointTool {
  area: string;
  description: string;
  inputSchema: ManifestEndpoint["inputs"];
  name: string;
  path: string;
  version: number;
}

/**
 * The tools a session is offered: per area, the highest version both the
 * generated manifest and the context route list, with only the listed
 * sections described. No list (absent or unreadable) offers nothing.
 */
export function offeredEndpointTools(
  available: readonly AvailableEndpoint[] | undefined,
  manifest: EndpointManifest = WIDGET_ENDPOINT_MANIFEST,
  held: ReadonlySet<string> = HELD_AREAS
): EndpointTool[] {
  const chosen = new Map<string, EndpointTool>();
  for (const entry of manifest.endpoints) {
    if (held.has(entry.name) || CODE_ONLY_AREAS.has(entry.name)) {
      continue;
    }
    const listed = available?.find(
      (candidate) =>
        candidate.name === entry.name &&
        candidate.version === entry.version &&
        candidate.path === entry.path
    );
    const current = chosen.get(entry.name);
    if (!listed || (current && current.version > entry.version)) {
      continue;
    }
    const { $schema: _schema, ...inputSchema } = entry.inputs;
    chosen.set(entry.name, {
      area: entry.name,
      description: describe(entry, listed.sections),
      inputSchema,
      name: endpointToolName(entry.name),
      path: entry.path,
      version: entry.version,
    });
  }
  return [...chosen.values()];
}

const RESPONSE_MAX_BYTES = 128 * 1024;
// Sections run in parallel under Acquisity's 20 s default each.
const ENDPOINT_TIMEOUT_MS = 45_000;
// Acquisity's handler answers each of these with a JSON status body.
const ANSWERED = new Set([200, 400, 401, 403, 503]);

/**
 * Calls one support endpoint for the verified chat and returns its body as it
 * came, so a status or field Foreman has never seen reaches the model instead
 * of failing the read. Refusals come back as results, never throws.
 */
export async function callWidgetEndpoint(
  ctx: WidgetAppContext,
  tool: { name: string; path: string },
  input: Record<string, unknown>,
  request: typeof fetch = fetch
): Promise<Record<string, unknown>> {
  const { conversationId } = requireWidgetContext(ctx.session?.auth.initiator);
  let outcome = "error";
  try {
    const { response, signal } = await postWidgetAppRoute(
      ctx,
      tool.path,
      input,
      ENDPOINT_TIMEOUT_MS,
      request
    );
    if (!ANSWERED.has(response.status)) {
      response.body?.cancel().catch(() => undefined);
      throw new Error(`Support endpoint answered ${response.status}.`);
    }
    const body = z
      .looseObject({ status: z.string().max(100) })
      .parse(await readContextBody(response, signal, RESPONSE_MAX_BYTES));
    outcome = body.status;
    return body;
  } catch (error) {
    if (ctx.abortSignal.aborted) {
      throw error;
    }
    return {
      message: "This check could not be read right now.",
      status: "unavailable",
    };
  } finally {
    logOpsEvent("widget.endpoint.call", {
      conversationId,
      outcome,
      tool: tool.name,
    });
  }
}

/**
 * The session's endpoint tools, keyed by tool name, or null when it has none
 * (agent/tools/widget_endpoints.ts resolves it at every step).
 */
export function endpointToolSet(
  initiator: SessionAuthContext | null,
  manifest: EndpointManifest = WIDGET_ENDPOINT_MANIFEST,
  held: ReadonlySet<string> = HELD_AREAS
) {
  const offered = offeredEndpointTools(
    widgetContext(initiator)?.endpoints,
    manifest,
    held
  );
  if (offered.length === 0) {
    return null;
  }
  return Object.fromEntries(
    offered.map((entry) => [
      entry.name,
      defineTool({
        approval: (toolCtx) =>
          isWidgetSupport(toolCtx.session.auth.initiator)
            ? "not-applicable"
            : {
                reason: "Support widget investigations only.",
                type: "denied",
              },
        description: entry.description,
        execute: (input: Record<string, unknown>, toolCtx) =>
          callWidgetEndpoint(
            toolCtx,
            { name: entry.name, path: entry.path },
            input
          ),
        inputSchema: entry.inputSchema,
      }),
    ])
  );
}
