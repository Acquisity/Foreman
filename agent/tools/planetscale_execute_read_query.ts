import { defineTool } from "eve/tools";
import { z } from "zod";
import { planetscaleAuth } from "#lib/constants.js";
import {
  callPlanetscaleReadQuery,
  parseReadQueryResult,
  truncateRows,
} from "#lib/planetscale.js";

/**
 * Maximum serialized size of the rows returned to the model, in bytes.
 *
 * The workflow stream caps each chunk at 10 MB; staying at 8 MB leaves headroom
 * for the surrounding JSON envelope and metadata so a single result never
 * exceeds the per-chunk limit.
 */
const MAX_RESULT_BYTES = 8 * 1024 * 1024;

export default defineTool({
  description:
    "Run a read-only SQL query against PlanetScale production Postgres and return the rows. " +
    "Results are capped at 8 MB; when `truncated` is true the rows are partial, so narrow the " +
    "query (a bounded COUNT, a tighter WHERE, or a LIMIT) and re-run rather than concluding " +
    "from a partial result. Never run a write.",
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
        success: false as const,
      };
    }

    const truncated = truncateRows(rows, MAX_RESULT_BYTES);
    return { ...truncated, ...passthrough };
  },
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
  outputSchema: z
    .object({
      error: z.string().optional(),
      resultBytes: z.number().optional(),
      returnedRows: z.number().optional(),
      rows: z.array(z.unknown()).optional(),
      success: z.boolean().optional(),
      totalRows: z.number().optional(),
      truncated: z.boolean().optional(),
    })
    .passthrough(),
});
