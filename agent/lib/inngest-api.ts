import { z } from "zod";
import { redact } from "./investigation-memory/case.js";

/** Inngest REST v2. The same API key the MCP connector holds authenticates it. */
export const INNGEST_API_BASE = "https://api.inngest.com/v2";
const REQUEST_TIMEOUT_MS = 15_000;
/** A trace with output can be large; anything past this is refused, not buffered. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RUN_LIMIT = 20;
const ERROR_CHARS = 500;
const MAX_STEPS = 200;

export const RUN_STATUSES = ["Failed", "Cancelled", "Completed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface FindFunctionRunsInput {
  /** Function id such as `ads.google.sync-workspace-insights`; omitted lists runs across every function. */
  functionId?: string;
  sinceHours: number;
  status: RunStatus;
}

export const functionRunSchema = z.object({
  endedAt: z.string().nullable(),
  eventId: z.string().nullable(),
  functionId: z.string().nullable(),
  functionName: z.string().nullable(),
  queuedAt: z.string().nullable(),
  runId: z.string(),
  startedAt: z.string().nullable(),
  status: z.string(),
});

export const traceStepSchema = z.object({
  endedAt: z.string().nullable(),
  error: z.string().optional(),
  name: z.string(),
  startedAt: z.string().nullable(),
  status: z.string(),
});

export const findFunctionRunsResultSchema = z.object({
  error: z.string().optional(),
  latestTrace: z
    .object({
      runId: z.string(),
      steps: z.array(traceStepSchema),
      truncated: z.boolean(),
    })
    .nullable(),
  runs: z.array(functionRunSchema),
  /** More runs matched than the 20 returned. */
  truncated: z.boolean(),
});

export type FindFunctionRunsResult = z.infer<
  typeof findFunctionRunsResultSchema
>;
type TraceStep = z.infer<typeof traceStepSchema>;

export interface InngestApiOptions {
  fetch?: typeof fetch;
  now?: Date;
  signal?: AbortSignal;
}

/** Bounded, redacted error text; Inngest errors arrive as strings or objects. */
export const errorText = (error: unknown): string | undefined => {
  if (error === null || error === undefined) {
    return undefined;
  }
  let raw = JSON.stringify(error);
  if (typeof error === "string") {
    raw = error;
  } else if (typeof error === "object" && "message" in error) {
    raw = String((error as { message: unknown }).message);
  }
  return redact(raw).slice(0, ERROR_CHARS);
};

const loose = z.looseObject({});
const str = z.union([z.string(), z.number()]).transform(String).nullish();

/** A run as `GET /v2/runs` returns it (shape pinned on a live response). */
const runRow = z.looseObject({
  endedAt: str,
  function: z.looseObject({ id: str, name: str }).nullish(),
  id: z.union([z.string(), z.number()]).transform(String),
  queuedAt: str,
  startedAt: str,
  status: z.string(),
  trigger: z.looseObject({ eventIds: z.array(z.string()).nullish() }).nullish(),
});

/** A span in `data.rootSpan` of `GET /v2/runs/{id}/trace`; attempts nest under their step. */
const spanRow = z.looseObject({
  children: z.array(loose).nullish(),
  endedAt: str,
  error: z.unknown().optional(),
  name: str,
  output: z.unknown().optional(),
  startedAt: str,
  status: str,
});

async function getJson(
  token: string,
  path: string,
  opts?: InngestApiOptions
): Promise<unknown> {
  const fetchImpl = opts?.fetch ?? fetch;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${INNGEST_API_BASE}${path}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
  } catch (error) {
    if (opts?.signal?.aborted) {
      throw error;
    }
    throw new Error(
      `Inngest API ${path.split("?")[0]} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (!response.ok) {
    throw new Error(
      `Inngest API ${path.split("?")[0]} failed: HTTP ${response.status}.`
    );
  }
  return JSON.parse(
    await readBoundedText(response, path.split("?")[0] ?? path)
  );
}

/** Reads a body up to {@link MAX_RESPONSE_BYTES}, cancelling the stream past it. */
async function readBoundedText(
  response: Response,
  what: string
): Promise<string> {
  const tooBig = () =>
    new Error(
      `Inngest API ${what} returned more than ${MAX_RESPONSE_BYTES} bytes.`
    );
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw tooBig();
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  // biome-ignore lint/suspicious/noUnnecessaryConditions: the stream's done flag terminates the loop.
  while (true) {
    // biome-ignore lint/performance/noAwaitInLoops: chunks are read sequentially to enforce the cap.
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

const MAX_APP_PAGES = 5;
const appPage = z.looseObject({
  data: z.array(z.looseObject({ id: z.string() })),
  page: z
    .looseObject({
      cursor: z.string().nullish(),
      hasMore: z.boolean().optional(),
    })
    .optional(),
});

const runPage = z.looseObject({
  data: z.array(loose),
  page: z.looseObject({ hasMore: z.boolean().optional() }).optional(),
});

/**
 * `GET /runs` lists across every function; the per-function route lives under
 * the app (`/apps/{appId}/functions/{functionId}/runs`, the only form that
 * accepts a dotted function id), so a function id first lists the apps.
 */
async function listRuns(
  token: string,
  functionId: string | undefined,
  params: URLSearchParams,
  opts?: InngestApiOptions
): Promise<z.infer<typeof runPage>> {
  if (!functionId) {
    return runPage.parse(
      await getJson(token, `/runs?${params.toString()}`, opts)
    );
  }
  const appIds: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_APP_PAGES; page += 1) {
    const appParams = new URLSearchParams({ limit: "20" });
    if (cursor) {
      appParams.set("cursor", cursor);
    }
    // biome-ignore lint/performance/noAwaitInLoops: app pages are sequential cursors.
    const body = await getJson(token, `/apps?${appParams.toString()}`, opts);
    const apps: z.infer<typeof appPage> = appPage.parse(body);
    appIds.push(...apps.data.map((app) => app.id));
    cursor = apps.page?.hasMore ? (apps.page.cursor ?? null) : null;
    if (!cursor) {
      break;
    }
  }
  if (cursor) {
    throw new Error(
      `Inngest API /apps has more than ${MAX_APP_PAGES * 20} apps; the function could not be located.`
    );
  }
  const data: Record<string, unknown>[] = [];
  let hasMore = false;
  for (const appId of appIds) {
    const path = `/apps/${encodeURIComponent(appId)}/functions/${encodeURIComponent(functionId)}/runs?${params.toString()}`;
    let page: z.infer<typeof runPage>;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one app at a time; there is one app today.
      page = runPage.parse(await getJson(token, path, opts));
    } catch (error) {
      // The function belongs to one app; the others answer 404.
      if (error instanceof Error && error.message.endsWith("HTTP 404.")) {
        continue;
      }
      throw error;
    }
    data.push(...page.data);
    hasMore = hasMore || page.page?.hasMore === true;
  }
  return {
    data: data.slice(0, RUN_LIMIT),
    page: { hasMore: hasMore || data.length > RUN_LIMIT },
  };
}

/** Flattens the span tree depth-first into steps, the root excluded. */
function flattenSteps(
  node: Record<string, unknown>,
  out: TraceStep[],
  isRoot: boolean
): boolean {
  if (out.length >= MAX_STEPS) {
    return true;
  }
  const span = spanRow.parse(node);
  if (!isRoot) {
    const failed = span.status?.toUpperCase() === "FAILED";
    const error =
      errorText(span.error) ??
      (failed && span.output !== undefined
        ? errorText(span.output)
        : undefined);
    out.push({
      endedAt: span.endedAt ?? null,
      ...(error ? { error } : {}),
      name: span.name ?? "(unnamed)",
      startedAt: span.startedAt ?? null,
      status: span.status ?? "UNKNOWN",
    });
  }
  let overflow = false;
  for (const child of span.children ?? []) {
    overflow = flattenSteps(child, out, false) || overflow;
  }
  return overflow;
}

/**
 * Two fixed calls: the newest runs with the given status in the window (for
 * one function when an id is given), then the trace of the newest run.
 */
export async function findFunctionRuns(
  token: string,
  input: FindFunctionRunsInput,
  opts?: InngestApiOptions
): Promise<FindFunctionRunsResult> {
  try {
    const now = opts?.now ?? new Date();
    const from = new Date(now.getTime() - input.sinceHours * 60 * 60 * 1000);
    const params = new URLSearchParams({
      from: from.toISOString(),
      limit: String(RUN_LIMIT),
      order: "DESC",
      status: input.status.toUpperCase(),
      timeField: "queuedAt",
    });
    const listed = await listRuns(token, input.functionId, params, opts);

    const runs = listed.data.map((row) => {
      const run = runRow.parse(row);
      return {
        endedAt: run.endedAt ?? null,
        eventId: run.trigger?.eventIds?.[0] ?? null,
        functionId: run.function?.id ?? null,
        functionName: run.function?.name ?? null,
        queuedAt: run.queuedAt ?? null,
        runId: run.id,
        startedAt: run.startedAt ?? null,
        status: run.status,
      };
    });

    const [newest] = runs;
    if (!newest) {
      return { latestTrace: null, runs, truncated: false };
    }
    const trace = z
      .looseObject({
        data: z.looseObject({ rootSpan: loose.optional() }).optional(),
      })
      .parse(
        await getJson(
          token,
          `/runs/${encodeURIComponent(newest.runId)}/trace?includeOutput=true`,
          opts
        )
      );
    const steps: TraceStep[] = [];
    const overflow = flattenSteps(trace.data?.rootSpan ?? {}, steps, true);
    return {
      latestTrace: { runId: newest.runId, steps, truncated: overflow },
      runs,
      truncated: listed.page?.hasMore === true,
    };
  } catch (error) {
    return {
      error: redact(
        error instanceof Error ? error.message : "Inngest read failed."
      ),
      latestTrace: null,
      runs: [],
      truncated: false,
    };
  }
}
