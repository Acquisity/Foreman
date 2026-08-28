import { defineTool } from "eve/tools";
import { z } from "zod";
import { planetscaleAuth } from "#lib/constants.js";
import {
  describeTable,
  describeTableResultSchema,
  tableNameSchema,
} from "#lib/describe-table.js";
import { PRODUCTION_READ_QUERY_ARGS } from "#lib/lookup-customer.js";
import {
  callPlanetscaleReadQuery,
  PlanetscaleHttpError,
} from "#lib/planetscale.js";

export default defineTool({
  description:
    "List the columns of one production table (name, type, nullable, default) from information_schema, in column order. " +
    "Call it before writing any planetscale_execute_read_query against a table whose column names you have not seen in this session; never guess a name into a query. " +
    "found false means no public table has that exact name, and similar lists up to 10 table names containing it. error means the lookup could not run.",
  async execute({ table }, ctx) {
    const { token } = await ctx.getToken(planetscaleAuth);
    return describeTable(table, async (query) => {
      try {
        return await callPlanetscaleReadQuery(token, {
          ...PRODUCTION_READ_QUERY_ARGS,
          query,
        });
      } catch (error) {
        if (
          error instanceof PlanetscaleHttpError &&
          (error.status === 401 || error.status === 403)
        ) {
          ctx.requireAuth(planetscaleAuth);
        }
        throw error;
      }
    });
  },
  inputSchema: z.object({
    table: tableNameSchema.describe(
      "The snake_case table name, such as member or organization."
    ),
  }),
  outputSchema: describeTableResultSchema,
});
