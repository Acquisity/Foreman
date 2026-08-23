/**
 * Applies `migrations/*.sql` to the investigation-memory database in filename
 * order, recording each applied file in `schema_migrations`.
 *
 * Run explicitly during setup or deployment (`pnpm db:migrate`), never from
 * agent startup. It needs FOREMAN_MEMORY_DATABASE_URL and nothing else. Each
 * file applies as one transaction together with its `schema_migrations` row,
 * so a half-applied migration is never recorded as done.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

// ponytail: statements are split on a trailing semicolon, so migration files
// must keep semicolons out of string literals and function bodies. A real
// parser only earns its keep once a migration needs one.
const STATEMENT_SEPARATOR = /;\s*$/m;
const COMMENT_ONLY = /^(?:--[^\n]*\n?)+$/;

const statements = (source: string): string[] =>
  source
    .split(STATEMENT_SEPARATOR)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "" && !COMMENT_ONLY.test(statement));

const url = process.env.FOREMAN_MEMORY_DATABASE_URL;
if (!url) {
  throw new Error("FOREMAN_MEMORY_DATABASE_URL is not set.");
}

const sql = neon(url);

await sql.query(
  "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
);

const applied = new Set(
  (
    (await sql.query("SELECT name FROM schema_migrations")) as {
      name: string;
    }[]
  ).map((row) => row.name)
);

const pending = (await readdir(MIGRATIONS_DIR))
  .filter((file) => file.endsWith(".sql") && !applied.has(file))
  .sort();

const apply = async (file: string): Promise<void> => {
  const source = await readFile(join(MIGRATIONS_DIR, file), "utf8");
  await sql.transaction([
    ...statements(source).map((statement) => sql.query(statement)),
    sql.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]),
  ]);
  process.stdout.write(`applied ${file}\n`);
};

// Sequential on purpose: migrations depend on the ones before them.
await pending.reduce(
  (chain, file) => chain.then(() => apply(file)),
  Promise.resolve()
);

process.stdout.write(
  pending.length === 0 ? "up to date\n" : `${pending.length} applied\n`
);
