import { z } from "zod";
import { parseReadQueryResult } from "./planetscale.js";

/** snake_case only; anything else is rejected before a request is made. */
export const tableNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z_][a-z0-9_]{0,62}$/u, "Expected a snake_case table name.");

/** The two fixed queries. The name is validated to the regex above, so it is safe to inline. */
export const columnsQuery = (table: string) =>
  [
    "select column_name, data_type, is_nullable, column_default",
    "from information_schema.columns",
    `where table_schema = 'public' and table_name = '${table}'`,
    "order by ordinal_position",
  ].join("\n");

/** `_` is a LIKE wildcard, so snake_case names are escaped and the pattern says so. */
const likePattern = (table: string) => `%${table.replace(/_/gu, "\\_")}%`;

export const similarTablesQuery = (table: string) =>
  [
    "select table_name",
    "from information_schema.tables",
    // Contains the name, or is contained in it (members -> member, member_preferences).
    `where table_schema = 'public' and (table_name like '${likePattern(table)}' escape '\\' or '${table}' like '%' || replace(table_name, '_', '\\_') || '%' escape '\\')`,
    "order by table_name",
    "limit 10",
  ].join("\n");

const columnRow = z.looseObject({
  column_default: z.union([z.string(), z.null()]).optional(),
  column_name: z.string(),
  data_type: z.string(),
  is_nullable: z.string(),
});

export const describeTableResultSchema = z.object({
  columns: z.array(
    z.object({
      default: z.string().nullable(),
      name: z.string(),
      nullable: z.boolean(),
      type: z.string(),
    })
  ),
  error: z.string().optional(),
  found: z.boolean(),
  /** Up to 10 table names containing the requested name, when it was not found. */
  similar: z.array(z.string()),
  table: z.string(),
});

export type DescribeTableResult = z.infer<typeof describeTableResultSchema>;

/**
 * Columns of one public table from `information_schema`, in ordinal order.
 * No rows means the table does not exist under that name; the result then
 * carries similar names so the caller corrects the name instead of guessing.
 */
export async function describeTable(
  rawTable: string,
  run: (query: string) => Promise<string>
): Promise<DescribeTableResult> {
  // The tool schema already enforces this; the library enforces it again so
  // no caller can hand the query builders anything but a bare identifier.
  const parsed = tableNameSchema.safeParse(rawTable);
  if (!parsed.success) {
    return {
      columns: [],
      error: "Expected a snake_case table name.",
      found: false,
      similar: [],
      table: rawTable,
    };
  }
  const table = parsed.data;
  try {
    const { rows } = parseReadQueryResult(await run(columnsQuery(table)));
    const columns = rows.map((row) => columnRow.parse(row));
    if (columns.length > 0) {
      return {
        columns: columns.map((column) => ({
          default: column.column_default ?? null,
          name: column.column_name,
          nullable: column.is_nullable.toUpperCase() === "YES",
          type: column.data_type,
        })),
        found: true,
        similar: [],
        table,
      };
    }
    const similarRows = parseReadQueryResult(
      await run(similarTablesQuery(table))
    ).rows;
    return {
      columns: [],
      found: false,
      similar: similarRows.map(
        (row) => z.object({ table_name: z.string() }).parse(row).table_name
      ),
      table,
    };
  } catch (error) {
    return {
      columns: [],
      error: error instanceof Error ? error.message : "Table lookup failed.",
      found: false,
      similar: [],
      table,
    };
  }
}
