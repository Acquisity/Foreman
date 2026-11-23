// Acquisity's support endpoints (ENG-20283) as widget tools. The manifest is
// Acquisity's `serializeForemanManifest()` output, copied into
// widget-endpoint-manifest.ts by scripts/widget-endpoint-tools.ts; each session
// is offered only the endpoints and sections the context route listed for the
// asking user, and the endpoint re-checks that list itself.
import type { SessionAuthContext } from "eve/context";
import { z } from "zod";
import { acquisityOrigin, readContextBody } from "./acquisity-origin.js";
import { logOpsEvent } from "./ops-log.js";
import { WIDGET_ENDPOINT_MANIFEST } from "./widget-endpoint-manifest.js";
import type {
  AvailableEndpoint,
  EndpointManifest,
  ManifestEndpoint,
} from "./widget-endpoint-schema.js";
import type { CheckId } from "./widget-progress.js";
import { requireWidgetContext } from "./widget-scope.js";

/**
 * Areas whose hand-written tool still answers. Each stays off the menu until
 * its switch PR compares the two on real conversations and deletes the old
 * tool; an area missing here is offered as soon as the manifest has it.
 */
export const HELD_AREAS: ReadonlySet<string> = new Set([
  "account",
  "ai-generation",
  "ai-sdr",
  "billing",
  "campaigns",
  "crm-contact",
  "inboxes",
  "lead-pipeline",
  "orders",
  "website",
]);
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
  "crm-contact": "leads",
  inboxes: "inboxes",
  "lead-pipeline": "leads",
  orders: "orders",
  website: "website",
};

export const endpointToolName = (area: string) =>
  `widget_${area.replaceAll("-", "_")}`;

/** Every tool name the manifest can produce, for the lane's allowlist. */
export const ENDPOINT_TOOL_NAMES: ReadonlySet<string> = new Set(
  WIDGET_ENDPOINT_MANIFEST.endpoints
    .filter((entry) => !CODE_ONLY_AREAS.has(entry.name))
    .map((entry) => endpointToolName(entry.name))
);

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
  manifest: EndpointManifest = WIDGET_ENDPOINT_MANIFEST
): EndpointTool[] {
  const chosen = new Map<string, EndpointTool>();
  for (const entry of manifest.endpoints) {
    if (HELD_AREAS.has(entry.name) || CODE_ONLY_AREAS.has(entry.name)) {
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
const ANSWERED = new Set([200, 400, 403, 503]);

/**
 * Calls one support endpoint for the verified chat and returns its body as it
 * came, so a status or field Foreman has never seen reaches the model instead
 * of failing the read. Refusals come back as results, never throws.
 */
export async function callWidgetEndpoint(
  ctx: {
    abortSignal: AbortSignal;
    session?: { auth: { initiator: SessionAuthContext | null } };
  },
  tool: { name: string; path: string },
  input: Record<string, unknown>,
  request: typeof fetch = fetch
): Promise<Record<string, unknown>> {
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  const secret = process.env.FOREMAN_DIAGNOSTICS_SECRET;
  const signal = AbortSignal.any([
    ctx.abortSignal,
    AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
  ]);
  let outcome = "error";
  try {
    if (!secret || secret.length < 32) {
      throw new Error("Support endpoints are not configured.");
    }
    const response = await request(`${acquisityOrigin()}${tool.path}`, {
      body: JSON.stringify({
        ...input,
        conversationId: scope.conversationId,
        organizationId: scope.organizationId,
        userId: scope.userId,
      }),
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal,
    });
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
      conversationId: scope.conversationId,
      outcome,
      tool: tool.name,
    });
  }
}
