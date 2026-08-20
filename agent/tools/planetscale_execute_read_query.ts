import { defineTool } from "eve/tools";
import { z } from "zod";
import { planetscaleAuth } from "#lib/constants.js";
import {
  buildReadQueryResult,
  callPlanetscaleReadQuery,
  PlanetscaleHttpError,
  parseReadQueryResult,
} from "#lib/planetscale.js";

/**
 * Maximum serialized size of the rows returned to the model, in bytes.
 *
 * The workflow stream caps each chunk at 10 MB, but the real consumer is the
 * model context, not the stream. 1 MB of JSON is already on the order of a
 * quarter-million tokens, so a result at this cap is still usable while staying
 * far under the stream limit. When a query returns more, the tool truncates and
 * flags it so the model narrows the query instead of concluding from a partial
 * result.
 */
const MAX_RESULT_BYTES = 1024 * 1024;

/** Bounded preview of raw text returned when a result cannot be parsed. */
const RAW_PREVIEW_BYTES = 4000;

export default defineTool({
  description:
    "Run a read-only SQL query against PlanetScale production Postgres and return the rows. " +
    "Results are capped at 1 MB; when `truncated` is true the rows are partial, so narrow the " +
    "query (a bounded COUNT, a tighter WHERE, or a LIMIT) and re-run rather than concluding " +
    "from a partial result. When `oversizedRow` is true a single row alone exceeded the cap, " +
    "so select fewer or narrower columns instead of re-running the same query. Never run a write.",
  async execute(input, ctx) {
    const { token } = await ctx.getToken(planetscaleAuth);

    const args: Record<string, unknown> = { query: input.query };
    if (input.database !== undefined) {
      args.database = input.database;
    }
    if (input.branch !== undefined) {
      args.branch = input.branch;
    }
    if (input.organization !== undefined) {
      args.organization = input.organization;
    }
    if (input.use_replica !== undefined) {
      args.use_replica = input.use_replica;
    }
    if (input.postgres_database_name !== undefined) {
      args.postgres_database_name = input.postgres_database_name;
    }

    let text: string;
    try {
      text = await callPlanetscaleReadQuery(token, args);
    } catch (error) {
      // A grant revoked mid-flight surfaces as a downstream 401/403; re-challenge
      // so eve evicts the dead bearer and mints a fresh token instead of handing
      // the model a dead-token error.
      if (
        error instanceof PlanetscaleHttpError &&
        (error.status === 401 || error.status === 403)
      ) {
        ctx.requireAuth(planetscaleAuth);
      }
      return {
        error: error instanceof Error ? error.message : "Read query failed.",
        success: false as const,
      };
    }

    let rows: unknown[];
    let passthrough: Record<string, unknown>;
    try {
      ({ rows, passthrough } = parseReadQueryResult(text));
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Result parse failed.",
        raw: text.slice(0, RAW_PREVIEW_BYTES),
        success: false as const,
      };
    }

    return buildReadQueryResult(rows, passthrough, MAX_RESULT_BYTES);
  },
  // Hand-copied from the PlanetScale MCP server's published schema for
  // `planetscale_execute_read_query`; keep in sync with the server if it adds
  // or renames fields.
  inputSchema: z.object({
    branch: z.string().optional().describe("The branch name."),
    database: z.string().optional().describe("The database name."),
    organization: z.string().optional().describe("The organization name."),
    postgres_database_name: z
      .string()
      .optional()
      .describe("The Postgres database name."),
    query: z.string().min(1).describe("The read-only SQL query to run."),
    use_replica: z
      .boolean()
      .optional()
      .describe("Whether to run against a read replica."),
  }),
  outputSchema: z.looseObject({
    envelopeTooLarge: z.boolean().optional(),
    error: z.string().optional(),
    oversizedRow: z.boolean().optional(),
    raw: z.string().optional(),
    resultBytes: z.number().optional(),
    returnedRows: z.number().optional(),
    rows: z.array(z.unknown()).optional(),
    success: z.boolean().optional(),
    totalRows: z.number().optional(),
    truncated: z.boolean().optional(),
  }),
});
