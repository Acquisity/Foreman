import { z } from "zod";
import { redact } from "./investigation-memory/case.js";
import { callMcpTool } from "./mcp-call.js";

/** The Raindrop MCP endpoint (Streamable HTTP transport). */
export const RAINDROP_MCP_URL = "https://mcp.raindrop.ai/mcp";
const SEARCH_STUMBLES_TOOL = "search_stumbles";
const REQUEST_TIMEOUT_MS = 30_000;
const TEXT_CHARS = 400;
const MAX_TAGS = 10;

export interface FindAiStumblesInput {
  /** Page number, 1-based; Raindrop returns 50 stumbles per page. */
  page: number;
  /** Case-insensitive text matched against title, subtitle, and description; omitted lists every stumble in the window. */
  query?: string;
  sinceHours: number;
}

export const stumbleSchema = z.object({
  createdAt: z.string().nullable(),
  /** When the failing interaction happened, as opposed to when Raindrop flagged it. */
  eventAt: z.string().nullable(),
  id: z.string(),
  subtitle: z.string().nullable(),
  tags: z.array(z.string()),
  title: z.string(),
});

export const findAiStumblesResultSchema = z.object({
  /** Minutes between Raindrop scans; the window is only current as of lastRunAt. */
  cadenceMinutes: z.number().nullable(),
  error: z.string().optional(),
  /** More stumbles matched than this page holds; call again with page + 1. */
  hasMore: z.boolean(),
  lastRunAt: z.string().nullable(),
  page: z.number(),
  stumbles: z.array(stumbleSchema),
});

export type FindAiStumblesResult = z.infer<typeof findAiStumblesResultSchema>;

export interface RaindropApiOptions {
  fetch?: typeof fetch;
  now?: Date;
  signal?: AbortSignal;
}

const str = z.string().nullish();

/** A stumble as `search_stumbles` returns it (shape pinned on a live response). */
const stumbleRow = z.looseObject({
  created_at: str,
  event_timestamp: str,
  id: z.string(),
  subtitle: str,
  tags: z.array(z.string()).nullish(),
  title: str,
});

const searchStumblesResponse = z.looseObject({
  cadence_minutes: z.number().nullish(),
  has_more: z.boolean().nullish(),
  last_run_at: str,
  page: z.number().nullish(),
  stumbles: z.array(stumbleRow).nullish(),
});

/** Bounded, redacted text; Raindrop's summaries are model-written and can quote a user. */
const text = (value: string | null | undefined): string | null =>
  value === null || value === undefined
    ? null
    : redact(value).slice(0, TEXT_CHARS);

/**
 * Searches Raindrop stumbles, the one-off failure modes of individual AI
 * interactions, by text and creation window.
 */
export async function findAiStumbles(
  token: string,
  input: FindAiStumblesInput,
  opts?: RaindropApiOptions
): Promise<FindAiStumblesResult> {
  const now = opts?.now ?? new Date();
  const createdAfter = new Date(
    now.getTime() - input.sinceHours * 3_600_000
  ).toISOString();
  const args: Record<string, unknown> = {
    created_after: createdAfter,
    page: input.page,
  };
  if (input.query) {
    args.query = input.query;
  }

  const raw = await callMcpTool({
    args,
    fetch: opts?.fetch,
    label: "Raindrop MCP",
    signal: opts?.signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
    token,
    tool: SEARCH_STUMBLES_TOOL,
    url: RAINDROP_MCP_URL,
  });

  let parsed: z.infer<typeof searchStumblesResponse>;
  try {
    parsed = searchStumblesResponse.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Raindrop search_stumbles returned an unrecognized result shape: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  return {
    cadenceMinutes: parsed.cadence_minutes ?? null,
    hasMore: parsed.has_more ?? false,
    lastRunAt: parsed.last_run_at ?? null,
    page: parsed.page ?? input.page,
    stumbles: (parsed.stumbles ?? []).map((row) => ({
      createdAt: row.created_at ?? null,
      eventAt: row.event_timestamp ?? null,
      id: row.id,
      subtitle: text(row.subtitle),
      tags: (row.tags ?? []).slice(0, MAX_TAGS),
      title: text(row.title) ?? "",
    })),
  };
}
