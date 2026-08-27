import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  columnsQuery,
  describeTable,
  tableNameSchema,
} from "./describe-table.js";

process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planet-scale-read-only-foreman/test";

const { PRODUCTION_READ_QUERY_ARGS } = await import("./lookup-customer.js");

describe("describe_table", () => {
  it("accepts snake_case only and rejects injection-shaped names", () => {
    assert.equal(tableNameSchema.parse(" Member "), "member");
    for (const bad of [
      "user;drop",
      "user'--",
      "User Table",
      "a".repeat(64),
      "",
    ]) {
      assert.equal(tableNameSchema.safeParse(bad).success, false, bad);
    }
  });

  it("always queries the public schema on the fixed production coordinates", () => {
    assert.ok(columnsQuery("member").includes("table_schema = 'public'"));
    assert.equal(PRODUCTION_READ_QUERY_ARGS.postgres_database_name, "postgres");
    assert.equal(PRODUCTION_READ_QUERY_ARGS.branch, "main");
  });

  it("returns typed columns in ordinal order", async () => {
    const result = await describeTable("member", () =>
      Promise.resolve(
        JSON.stringify([
          {
            column_default: "gen_random_uuid()",
            column_name: "id",
            data_type: "uuid",
            is_nullable: "NO",
          },
          {
            column_default: null,
            column_name: "deleted_at",
            data_type: "timestamp with time zone",
            is_nullable: "YES",
          },
        ])
      )
    );
    assert.equal(result.found, true);
    assert.deepEqual(result.columns[1], {
      default: null,
      name: "deleted_at",
      nullable: true,
      type: "timestamp with time zone",
    });
  });

  it("reports a missing table with similar names from the second fixed query", async () => {
    const queries: string[] = [];
    const result = await describeTable("members", (query) => {
      queries.push(query);
      return Promise.resolve(
        queries.length === 1
          ? "[]"
          : JSON.stringify([
              { table_name: "member" },
              { table_name: "member_preferences" },
            ])
      );
    });
    assert.equal(result.found, false);
    assert.deepEqual(result.similar, ["member", "member_preferences"]);
    assert.ok(queries[1]?.includes("information_schema.tables"));
  });

  it("returns error instead of throwing when the query fails", async () => {
    const result = await describeTable("member", () =>
      Promise.reject(new Error("HTTP 500"))
    );
    assert.equal(result.found, false);
    assert.equal(result.error, "HTTP 500");
  });
});
