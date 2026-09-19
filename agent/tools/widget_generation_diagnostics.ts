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

const DECISION_LIMIT = 50;
const ISSUE_TYPE_LIMIT = 20;
const AGENT_LIMIT = 20;
const SIGNAL_LIMIT = 20;
const CANDIDATE_LIMIT = 200;
const COPY_REVIEW_AGENT = "copy-review";
const SENTRY_ISSUES_PATH = "sentry.user.personalSentry.search_issues";
const AXIOM_QUERY_PATH = "axiom.user.personalAxiom.querydataset";
/** agent_executions records the AI SDR workflow's own agent runs, one row per decision. */
const AGENT_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const DATASET_NAME = /^[A-Za-z0-9._-]{1,120}$/;

/** Copy-review issue categories are a fixed enum in the product; only these may cross the boundary. */
export const COPY_REVIEW_ISSUE_TYPES = [
  "tone_mismatch",
  "warmth_deficit",
  "robotic_closing",
  "false_booking_confirmation",
  "missing_booking_invite",
  "fabricated_url",
  "fabricated_detail",
  "calendar_system_leak",
  "multi_round_patience",
  "emotional_override_needed",
  "question_fabrication",
  "review_unavailable",
] as const;
const issueTypeSet: ReadonlySet<string> = new Set(COPY_REVIEW_ISSUE_TYPES);

const WINDOWS = {
  "7d": { apl: "7d", sql: "7 days" },
  "24h": { apl: "24h", sql: "24 hours" },
  "30d": { apl: "30d", sql: "30 days" },
} as const;
type WindowKey = keyof typeof WINDOWS;

export const widgetGenerationDiagnosticsInput = z.strictObject({
  agent: z.string().regex(AGENT_NAME).optional(),
  since: z.enum(["24h", "7d", "30d"]).default("7d"),
  threadId: z.uuid().optional(),
});
export type WidgetGenerationDiagnosticsInput = z.input<
  typeof widgetGenerationDiagnosticsInput
>;
type ResolvedInput = z.infer<typeof widgetGenerationDiagnosticsInput>;

const count = z.number().int().nonnegative();
const timestamp = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)));
const signalKind = z.enum([
  "failed_generation",
  "empty_response",
  "looping",
  "error",
]);
type SignalKind = z.infer<typeof signalKind>;
const outcome = z.enum(["pass", "block", "completed", "error"]);

const signal = z.object({
  count,
  errorClass: z.string().min(1).max(80),
  kind: signalKind,
  lastSeen: timestamp.nullable(),
});
const sourceSignals = z.object({
  items: z.array(signal).max(SIGNAL_LIMIT),
  status: z.enum(["ok", "unavailable"]),
});
type SourceSignals = z.infer<typeof sourceSignals>;
const decision = z.object({
  agentName: z.string().min(1).max(60),
  hadError: z.boolean(),
  outcome,
  startedAt: timestamp,
  success: z.boolean(),
});
const issueTypeCount = z.object({
  count,
  type: z.enum(COPY_REVIEW_ISSUE_TYPES),
});
const agentFailure = z.object({
  agentName: z.string().min(1).max(60),
  failures: count,
  lastSeen: timestamp,
});
const executions = z.object({
  copyReview: z.object({
    blockedIssueTypes: z.array(issueTypeCount).max(ISSUE_TYPE_LIMIT),
    blocks: count,
    passes: count,
  }),
  decisions: z.array(decision).max(DECISION_LIMIT),
  failuresByAgent: z.array(agentFailure).max(AGENT_LIMIT),
});
export const widgetGenerationDiagnosticsOutput = z.union([
  z.object({
    caveats: z.array(z.string()).max(6),
    executions,
    observedAt: timestamp,
    signals: z.object({ axiom: sourceSignals, sentry: sourceSignals }),
    source: z.literal(
      "Acquisity product database and sanitized error signals; not a live model check"
    ),
    status: z.literal("ok"),
    window: z.enum(["24h", "7d", "30d"]),
    workspace: z.string().max(500),
  }),
  z.object({
    message: z.string(),
    status: z.enum(["unavailable", "denied"]),
  }),
]);
export type WidgetGenerationDiagnosticsOutput = z.infer<
  typeof widgetGenerationDiagnosticsOutput
>;

/**
 * Fixed statement only. Every row hangs off the authorized workspace, membership
 * is re-checked in the same snapshot, and no free-text selector reaches the SQL.
 */
export function buildGenerationDiagnosticsQuery(
  context: WidgetContext,
  raw: WidgetGenerationDiagnosticsInput
): string {
  const scope = widgetContextSchema.parse(context);
  const input = widgetGenerationDiagnosticsInput.parse(raw);
  const authorization = `with authorized as (
    select o.id from organization o join member m on m.organization_id = o.id
    where o.id = '${scope.organizationId}'::uuid and m.user_id = '${scope.userId}'::uuid
      and o.deleted_at is null and m.deleted_at is null and m.role in ('owner', 'admin')
      and (o.partner_id is null or o.partner_id = '${scope.partnerId}'::uuid)
  )`;
  // output/reasoning/input/model/error bodies stay in the database; only the
  // decision shape and the fixed copy-review issue enum leave it.
  const records = `select a.agent_name as "agentName", a.success,
      (a.error is not null) as "hadError", a.started_at as "startedAt",
      case when a.agent_name = '${COPY_REVIEW_AGENT}'
        then (a.output->>'passed')::boolean else null end as passed,
      case when a.agent_name = '${COPY_REVIEW_AGENT}'
        then coalesce((select jsonb_agg(distinct e->>'type') from jsonb_array_elements(
          case when jsonb_typeof(a.output->'issues') = 'array'
            then a.output->'issues' else '[]'::jsonb end) e), '[]'::jsonb)
        else null end as "issueTypes"
    from agent_executions a join authorized au on au.id = a.organization_id
    where a.started_at > current_timestamp - interval '${WINDOWS[input.since].sql}'
      ${input.agent ? `and a.agent_name = '${input.agent}'` : ""}
      ${input.threadId ? `and a.thread_id = '${input.threadId}'::uuid` : ""}
    order by a.started_at desc, a.id desc
    limit ${DECISION_LIMIT}`;
  return `${authorization}
    select (select count(*) = 1 from authorized) as authorized,
      current_timestamp as "observedAt",
      coalesce((select jsonb_agg(to_jsonb(r)) from (${records}) r), '[]'::jsonb) as records`;
}

const ERROR_CLASS = /[^A-Za-z0-9_.$-]/g;
const CLASS_HEAD = /[:\n]/;
const AGENT_LABEL = /[^a-z0-9_-]/g;
const KIND_EMPTY = /empty|no.?(output|response|content)|blank|zero.?length/;
const KIND_LOOP = /loop|repeat|infinite|stuck|max.?(iteration|step)/;
const KIND_FAILED =
  /timeout|abort|throttl|rate.?limit|overload|fail|refus|invalid/;

/** Reduce any raw value to a bounded class token: no message, URL, path or trace survives. */
export function sanitizeErrorClass(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  const head = text.split(CLASS_HEAD)[0].split(" at ")[0].trim();
  const cleaned = head.replace(ERROR_CLASS, "").slice(0, 80);
  return cleaned || "UnknownError";
}

const sanitizeAgentName = (raw: string): string =>
  raw.toLowerCase().replace(AGENT_LABEL, "").slice(0, 60) || "unknown";

function classifyKind(text: string): SignalKind {
  const value = text.toLowerCase();
  if (KIND_EMPTY.test(value)) {
    return "empty_response";
  }
  if (KIND_LOOP.test(value)) {
    return "looping";
  }
  if (KIND_FAILED.test(value)) {
    return "failed_generation";
  }
  return "error";
}

const toCount = (raw: unknown): number => {
  let value = 1;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "string") {
    value = Number(raw);
  }
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 1;
};
const toTimestamp = (raw: unknown): string | null =>
  typeof raw === "string" &&
  raw.length <= 64 &&
  Number.isFinite(Date.parse(raw))
    ? raw
    : null;

/** Pull the row array out of whatever envelope the signal provider returned. */
function collectRows(parsed: unknown): unknown[] {
  const flatten = (rows: unknown[]): unknown[] =>
    rows
      .slice(0, CANDIDATE_LIMIT)
      .map((row) =>
        row &&
        typeof row === "object" &&
        "data" in row &&
        (row as { data?: unknown }).data &&
        typeof (row as { data: unknown }).data === "object"
          ? { ...(row as object), ...(row as { data: object }).data }
          : row
      );
  if (Array.isArray(parsed)) {
    return flatten(parsed);
  }
  if (parsed && typeof parsed === "object") {
    for (const key of [
      "issues",
      "events",
      "data",
      "results",
      "rows",
      "matches",
    ]) {
      const value = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        return flatten(value);
      }
    }
  }
  return [];
}

/**
 * Sanitize signal candidates and DROP anything not carrying this workspace's id.
 * Sentry and Axiom hold every customer's telemetry, so the org gate is the wall.
 */
export function toSignals(
  rows: unknown[],
  scope: WidgetContext
): z.infer<typeof signal>[] {
  const orgId = scope.organizationId.toLowerCase();
  const merged = new Map<
    string,
    {
      count: number;
      errorClass: string;
      kind: SignalKind;
      lastSeen: string | null;
    }
  >();
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    // The org id is stamped as a Sentry tag and an Axiom top-level field; if it
    // is absent from the record, the record is another workspace's and is dropped.
    if (!JSON.stringify(row).toLowerCase().includes(orgId)) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const source =
      record.errorClass ??
      record.error ??
      record.title ??
      record.culprit ??
      record.msg ??
      record.message ??
      record.type;
    const errorClass = sanitizeErrorClass(source);
    const kind = classifyKind(typeof source === "string" ? source : "");
    const rowCount = toCount(
      record.count ?? record.events ?? record.total ?? record.userCount ?? 1
    );
    const lastSeen = toTimestamp(
      record.lastSeen ?? record.last_seen ?? record._time ?? record.timestamp
    );
    const key = `${kind} ${errorClass}`;
    const prev = merged.get(key);
    if (prev) {
      prev.count += rowCount;
      if (lastSeen && (!prev.lastSeen || lastSeen > prev.lastSeen)) {
        prev.lastSeen = lastSeen;
      }
    } else {
      merged.set(key, { count: rowCount, errorClass, kind, lastSeen });
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, SIGNAL_LIMIT);
}

const dbRow = z.object({
  agentName: z.string().min(1).max(120),
  hadError: z.boolean(),
  issueTypes: z.array(z.string()).nullable(),
  passed: z.boolean().nullable(),
  startedAt: timestamp,
  success: z.boolean(),
});
type DbRow = z.infer<typeof dbRow>;

const rowOutcome = (row: DbRow): z.infer<typeof outcome> => {
  if (row.agentName === COPY_REVIEW_AGENT && row.passed !== null) {
    return row.passed ? "pass" : "block";
  }
  return row.success ? "completed" : "error";
};

type ExecutionsResult =
  | { executions: z.infer<typeof executions> }
  | { status: "denied" | "unavailable"; message: string };

const tallyCopyReview = (
  rows: DbRow[]
): z.infer<typeof executions>["copyReview"] => {
  const reviews = rows.filter((row) => row.agentName === COPY_REVIEW_AGENT);
  const blocked = reviews.filter((row) => rowOutcome(row) === "block");
  const blockedTypes = new Map<string, number>();
  for (const type of blocked.flatMap((row) => row.issueTypes ?? [])) {
    if (issueTypeSet.has(type)) {
      blockedTypes.set(type, (blockedTypes.get(type) ?? 0) + 1);
    }
  }
  return {
    blockedIssueTypes: [...blockedTypes.entries()]
      .map(([type, value]) => ({ count: value, type }))
      .sort((a, b) => b.count - a.count)
      .slice(0, ISSUE_TYPE_LIMIT) as z.infer<typeof issueTypeCount>[],
    blocks: blocked.length,
    passes: reviews.filter((row) => rowOutcome(row) === "pass").length,
  };
};

const tallyFailures = (
  rows: DbRow[]
): z.infer<typeof executions>["failuresByAgent"] => {
  const failures = new Map<string, { failures: number; lastSeen: string }>();
  for (const row of rows) {
    if (row.success && !row.hadError) {
      continue;
    }
    const agentName = sanitizeAgentName(row.agentName);
    const prev = failures.get(agentName);
    if (prev) {
      prev.failures += 1;
      prev.lastSeen =
        row.startedAt > prev.lastSeen ? row.startedAt : prev.lastSeen;
    } else {
      failures.set(agentName, { failures: 1, lastSeen: row.startedAt });
    }
  }
  return [...failures.entries()]
    .map(([agentName, value]) => ({ agentName, ...value }))
    .sort((a, b) => b.failures - a.failures)
    .slice(0, AGENT_LIMIT);
};

/** Fold the recorded decisions into the bounded, sanitized aggregate. */
function aggregateExecutions(rows: DbRow[]): z.infer<typeof executions> {
  return {
    copyReview: tallyCopyReview(rows),
    decisions: rows.map((row) => ({
      agentName: sanitizeAgentName(row.agentName),
      hadError: row.hadError,
      outcome: rowOutcome(row),
      startedAt: row.startedAt,
      success: row.success,
    })),
    failuresByAgent: tallyFailures(rows),
  };
}

/** Parse only the declared envelope and the fixed row shape; never forward raw bodies. */
export function parseExecutions(
  data: unknown
): ExecutionsResult & { observedAt?: string } {
  const envelope = z
    .object({
      rows: z
        .array(
          z.object({
            authorized: z.boolean(),
            observedAt: timestamp,
            records: z.array(z.unknown()).max(DECISION_LIMIT),
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
  const rows = z.array(dbRow).max(DECISION_LIMIT).parse(result.records);
  return {
    executions: aggregateExecutions(rows),
    observedAt: result.observedAt,
  };
}

async function dispatchWidget(
  ctx: ProviderContext,
  path: string,
  input: Record<string, unknown>
): Promise<unknown> {
  const result = await invokeProvider(ctx, path, input, undefined, {
    maxBytes: 64 * 1024,
    timeoutMs: 50_000,
  });
  if (!result.ok || (result.http && result.http.status !== 200)) {
    throw new Error("Signal provider unavailable.");
  }
  return result.data;
}

/** Recent unresolved AI generation errors for this workspace, sanitized to classes. */
async function readSentrySignals(
  ctx: ProviderContext,
  scope: WidgetContext,
  window: WindowKey
): Promise<SourceSignals> {
  // ponytail: Foreman's Sentry org slug is deployment config; unset means the
  // wiring is absent, which is unavailable, not an empty result. Confirm the
  // search_issues arg shape against the live catalog before relying on prod rows.
  const organizationSlug = process.env.WIDGET_SENTRY_ORG_SLUG;
  if (!organizationSlug) {
    return { items: [], status: "unavailable" };
  }
  try {
    const data = await dispatchWidget(ctx, SENTRY_ISSUES_PATH, {
      organizationSlug,
      query: `is:unresolved organizationId:${scope.organizationId} AI SDR generation, copy or model-call errors in the last ${WINDOWS[window].apl}`,
    });
    return {
      items: toSignals(collectRows(providerData(data)), scope),
      status: "ok",
    };
  } catch {
    return { items: [], status: "unavailable" };
  }
}

/** Recent AI generation error/empty log signals for this workspace, sanitized to classes. */
async function readAxiomSignals(
  ctx: ProviderContext,
  scope: WidgetContext,
  window: WindowKey
): Promise<SourceSignals> {
  // ponytail: the app-log dataset name is deployment config; unset means the
  // wiring is absent (unavailable, not empty). Confirm dataset fields against
  // the live catalog before relying on prod rows.
  const dataset = process.env.WIDGET_AXIOM_APP_DATASET;
  if (!(dataset && DATASET_NAME.test(dataset))) {
    return { items: [], status: "unavailable" };
  }
  try {
    const apl = [
      `['${dataset}']`,
      `| where _time > ago(${WINDOWS[window].apl})`,
      `| where organizationId == '${scope.organizationId}'`,
      "| where level == 'error' or isnotnull(errorClass)",
      "| summarize count = count(), lastSeen = max(_time) by errorClass",
      "| sort by count desc",
      `| limit ${SIGNAL_LIMIT}`,
    ].join("\n");
    const data = await dispatchWidget(ctx, AXIOM_QUERY_PATH, { apl });
    return {
      items: toSignals(collectRows(providerData(data)), scope),
      status: "ok",
    };
  } catch {
    return { items: [], status: "unavailable" };
  }
}

const CAVEATS = [
  "Decisions are recorded AI SDR agent runs; a blocked copy-review means the gate held before send, not that a customer received the email.",
  "Error and empty signals are reduced to a class, kind and count; the underlying logs, prompts, messages and model names are never included.",
  "A source marked unavailable was unreachable or unconfigured; it is not a zero. Unavailable is not empty.",
  "All counts cover the selected window only, and saved state is not a live model check.",
];

/** Widget reads accept only a window and optional owned agent/thread selectors. */
export async function readWidgetGenerationDiagnostics(
  ctx: ProviderContext,
  raw: WidgetGenerationDiagnosticsInput
): Promise<WidgetGenerationDiagnosticsOutput> {
  const scope = requireWidgetContext(ctx.session?.auth.initiator);
  const input: ResolvedInput = widgetGenerationDiagnosticsInput.parse(raw);
  const query = buildGenerationDiagnosticsQuery(scope, input);
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
    const parsed = parseExecutions(result.data);
    if ("status" in parsed) {
      return { message: parsed.message, status: parsed.status };
    }
    ctx.abortSignal.throwIfAborted();
    const [sentry, axiom] = await Promise.all([
      readSentrySignals(ctx, scope, input.since),
      readAxiomSignals(ctx, scope, input.since),
    ]);
    return widgetGenerationDiagnosticsOutput.parse({
      caveats: CAVEATS,
      executions: parsed.executions,
      observedAt: parsed.observedAt,
      signals: { axiom, sentry },
      source:
        "Acquisity product database and sanitized error signals; not a live model check",
      status: "ok",
      window: input.since,
      workspace: scope.organizationName,
    });
  } catch (error) {
    if (ctx.abortSignal.aborted) {
      throw error;
    }
    // Parser and provider errors may carry customer rows or credentials. Never forward them.
    logOpsEvent(
      "widget.support.generation_diagnostics.failed",
      {
        code: stage,
        outcome: "error",
        tool: "widget_generation_diagnostics",
      },
      console.warn
    );
    return {
      message:
        "AI generation diagnostics could not be checked. This is not an empty result; no source in it should be read as empty.",
      status: "unavailable",
    };
  }
}

const tool = defineTool({
  description:
    "Diagnose AI-output quality problems only in this chat's verified workspace: SDR emails with fabricated or hallucinated content, wrong sign-off or language, and empty or looping Ask AI responses. Returns recent AI SDR agent decisions with copy-review gate outcomes (passes, blocks, and the fixed issue categories that blocked) from the product database, plus recent model-call error and empty-response signals reduced to an error class, kind, count and last-seen from Sentry and Axiom for this workspace. Optional selectors: since (24h, 7d, 30d), an agent name, or a thread UUID owned by this workspace. Sanitized for a support teammate: no raw logs, prompts, traces, model names or other workspaces' data. A source marked unavailable is not empty. No SQL, workspace or field selector is accepted.",
  execute: async (input, ctx: ToolContext) =>
    readWidgetGenerationDiagnostics(ctx, input),
  inputSchema: widgetGenerationDiagnosticsInput,
  outputSchema: widgetGenerationDiagnosticsOutput,
});

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) =>
      isWidgetSupport(ctx.session.auth.initiator) ? tool : null,
  },
});
