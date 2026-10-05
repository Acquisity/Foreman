import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import { verifiedWidgetContext } from "./widget.fixture.js";
import { type CandidateRow, parseExcludedOrgs } from "./widget-candidates.js";
import { WIDGET_SUPPORT_ISSUER } from "./widget-scope.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const RUN = "wrun_01K00000000000000000000000";
const SINCE = "2026-10-05T14:00:00.000Z";
const at = new Date("2026-10-05T15:00:00.000Z");
const row = (conversation = 1): CandidateRow => ({
  completed_at: at,
  conversation_id: `33333333-3333-4333-8333-${String(conversation).padStart(12, "0")}`,
  created_at: at,
  decision: "block",
  findings: null,
  id: `44444444-4444-4444-8444-${String(conversation).padStart(12, "0")}`,
  organization_id: ORG,
  outcome: {
    decision: "block",
    message: null,
    reason: "needs_human",
    status: "completed",
  },
  question: "Synthetic question",
  scope: { organizationSlug: "fixture" },
  session_id: RUN,
});

const fixture = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "widget-candidate-pull-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const reviewDirectory = join(directory, ".eve/widget-candidates");
  const pendingDirectory = join(directory, "pending");
  await mkdir(reviewDirectory, { recursive: true });
  await mkdir(pendingDirectory);
  return {
    excluded: parseExcludedOrgs(undefined),
    pendingDirectory,
    reviewDirectory,
    since: SINCE,
  };
};

const candidateCommand = async (
  t: TestContext,
  rows: CandidateRow[],
  scenario = "success"
) => {
  const options = await fixture(t);
  const directory = resolve(options.reviewDirectory, "../..");
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(join(directory, "rows.json"), JSON.stringify(rows));
  await writeFile(
    join(directory, "database.mjs"),
    `
import { DatabaseSync } from "node:sqlite";
import { readFileSync, appendFileSync } from "node:fs";
const db = new DatabaseSync(":memory:");
const rows = JSON.parse(readFileSync("rows.json", "utf8"));
const columns = Object.keys(rows[0]);
db.exec("CREATE TABLE widget_support_runs (" + columns.map(c => c + " TEXT").join(",") + ")");
const insert = db.prepare("INSERT INTO widget_support_runs VALUES (" + columns.map(() => "?").join(",") + ")");
for (const row of rows) insert.run(...columns.map(c => typeof row[c] === "object" && row[c] !== null ? JSON.stringify(row[c]) : row[c]));
export function privateDatabase() {
  return { query: async (sql, params) => {
    appendFileSync("queries.jsonl", JSON.stringify({sql,params}) + "\\n");
    // SQLite executes the SELECT, window and conversation joins; only Postgres array syntax differs.
    const translated = sql.replaceAll("= ANY($2::uuid[])", "IN (SELECT value FROM json_each($2))").replaceAll("::uuid", "");
    const statement = db.prepare(translated);
    const bindings = Object.fromEntries(params.map((p,i) => ["$" + (i+1), Array.isArray(p) ? JSON.stringify(p) : p]));
    return statement.all(bindings).map(row => ({ ...row, outcome: JSON.parse(row.outcome), scope: JSON.parse(row.scope), findings: JSON.parse(row.findings) }));
  }};
}
`
  );
  await writeFile(
    join(directory, "hook.mjs"),
    `
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith("/private-postgres.js")) return { shortCircuit: true, url: new URL("./database.mjs", import.meta.url).href };
  return next(specifier, context);
}});
`
  );
  const shim = join(bin, "npx");
  await writeFile(
    shim,
    `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const attempts = existsSync("attempts.txt") ? Number(readFileSync("attempts.txt", "utf8")) + 1 : 1;
writeFileSync("attempts.txt", String(attempts));
const scenario = ${JSON.stringify(scenario)};
if (scenario === "leak" || (scenario === "transient" && attempts === 1)) {
  console.error("Error: synthetic-customer@example.com private reply");
  process.exit(scenario === "leak" ? 3 : 1);
}
const args = process.argv.slice(2);
const option = args.indexOf("--output-dir");
const directory = option < 0 ? "evals/widget/cases" : args[option + 1];
mkdirSync(directory, {recursive:true});
writeFileSync(join(directory, args[4] + ".json"), "{}");
`
  );
  await chmod(shim, 0o755);
  const command = promisify(execFile);
  const run = (first = true) =>
    command(
      process.execPath,
      [
        resolve("node_modules/tsx/dist/cli.mjs"),
        "--disable-warning=ExperimentalWarning",
        "--import",
        join(directory, "hook.mjs"),
        resolve("scripts/widget-candidates.ts"),
        ...(first ? ["--since", SINCE] : []),
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          WIDGET_CANDIDATES_EXCLUDE_ORGS: "",
        },
        timeout: 30_000,
      }
    );
  return { ...options, directory, run };
};

const summaryFrom = (stdout: string) => {
  const line = stdout
    .split("\n")
    .find((value) => value.startsWith("Pull summary: "));
  assert.ok(line, stdout);
  return JSON.parse(line.slice("Pull summary: ".length)) as {
    flagged: number;
    conversations: number;
    converted: number;
    refused: number;
  };
};

test("conversion errors keep customer diagnostics private and print only a fixed failure class", async (t) => {
  const command = await candidateCommand(t, [row()], "leak");
  const first = await command.run();
  assert.ok(
    !(first.stdout + first.stderr).includes("synthetic-customer@example.com")
  );
  assert.equal(summaryFrom(first.stdout).refused, 1);
  assert.ok(first.stdout.includes("leak_refused"));
  const diagnostic = await readFile(
    join(
      command.reviewDirectory,
      `candidate-${RUN.toLowerCase().replace("_", "-")}-failure.json`
    ),
    "utf8"
  );
  assert.ok(diagnostic.includes("synthetic-customer@example.com"));
  await command.run(false);
  assert.equal(
    await readFile(join(command.directory, "attempts.txt"), "utf8"),
    "1"
  );
});

test("a transient conversion retries beyond the cursor without rewriting the review", async (t) => {
  const command = await candidateCommand(t, [row()], "transient");
  const first = await command.run();
  const reviews = (await readdir(command.reviewDirectory)).filter((name) =>
    name.startsWith("review-")
  );
  const second = await command.run(false);
  assert.equal(
    await readFile(join(command.directory, "attempts.txt"), "utf8"),
    "2"
  );
  assert.equal(summaryFrom(first.stdout).refused, 1);
  assert.equal(summaryFrom(second.stdout).flagged, 0);
  assert.equal(summaryFrom(second.stdout).converted, 1);
  assert.deepEqual(
    (await readdir(command.reviewDirectory)).filter((name) =>
      name.startsWith("review-")
    ),
    reviews
  );
  const third = await command.run(false);
  assert.equal(summaryFrom(third.stdout).converted, 0);
  assert.equal(
    await readFile(join(command.directory, "attempts.txt"), "utf8"),
    "2"
  );
});

test("a converter formatting failure with --output-dir never writes an active eval case", async (t) => {
  const options = await fixture(t);
  const directory = resolve(options.reviewDirectory, "../..");
  const bin = join(directory, "bin");
  await mkdir(bin);
  const shim = join(bin, "npx");
  const context = { ...verifiedWidgetContext, source: "widget" };
  const record = {
    createdAt: SINCE,
    input: [
      {
        serializedContext: {
          "eve.auth": { attributes: context, issuer: WIDGET_SUPPORT_ISSUER },
        },
      },
    ],
  };
  const stream = JSON.stringify(
    Object.fromEntries(
      Buffer.from(
        `${JSON.stringify({ data: { message: "Synthetic question" }, meta: { at: SINCE }, type: "message.received" })}\n`
      ).entries()
    )
  );
  await writeFile(
    shim,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "biome") process.exit(1);
const streams = ${JSON.stringify(JSON.stringify([{ streamId: "fixture_user" }]))};
const stream = ${JSON.stringify(stream)};
const record = ${JSON.stringify(JSON.stringify(record))};
console.log(args.includes("streams") ? streams : args.includes("stream") ? stream : record);
`
  );
  await chmod(shim, 0o755);
  const command = promisify(execFile);
  let exitCode = 0;
  await assert.rejects(
    command(
      process.execPath,
      [
        resolve("node_modules/tsx/dist/cli.mjs"),
        resolve("scripts/widget-case-from-run.ts"),
        RUN,
        "production",
        "fixture",
        "--output-dir",
        options.pendingDirectory,
      ],
      {
        cwd: directory,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        timeout: 30_000,
      }
    ),
    (error: unknown) => {
      exitCode = (error as { code: number }).code;
      return true;
    }
  );
  assert.ok(!existsSync(join(directory, "evals/widget/cases/fixture.json")));
  assert.ok(!existsSync(join(options.pendingDirectory, "fixture.json")));
  assert.equal(exitCode, 4);
});

test("company test workspaces are excluded by default and extra exclusions are additive", () => {
  const defaults = parseExcludedOrgs(undefined);
  assert.ok(defaults.has("5a30d304-32ab-4ee0-b7ea-c5605aa34ce5"));
  assert.ok(defaults.has("af11d514-3fbd-459c-8425-81b6b80929a0"));
  const extra = parseExcludedOrgs(ORG);
  assert.ok(extra.has(ORG));
  for (const id of defaults) {
    assert.ok(extra.has(id));
  }
});

test("excluded traffic stays out of bound SELECTs and large pulls page whole conversations", async (t) => {
  const rows = [1, 2, 3].flatMap((conversation) =>
    Array.from({ length: 3000 }, (_, i) => ({
      ...row(conversation),
      id: `44444444-4444-4444-8444-${String(conversation * 3000 + i).padStart(12, "0")}`,
      organization_id:
        conversation === 3 ? "5a30d304-32ab-4ee0-b7ea-c5605aa34ce5" : ORG,
      question: `Synthetic distinct question ${i}`,
      session_id: null,
    }))
  );
  const command = await candidateCommand(t, rows);
  const result = summaryFrom((await command.run()).stdout);
  assert.equal(result.conversations, 2);
  assert.equal(result.flagged, 2);
  const queries = (
    await readFile(join(command.directory, "queries.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { sql: string; params: unknown[] });
  assert.equal(queries.length, 3);
  for (const { sql, params } of queries) {
    // Exclude before the window budget and in the qualifying subquery and final SELECT.
    assert.equal(
      sql.match(/NOT \(organization_id = ANY\(\$2::uuid\[\]\)\)/g)?.length,
      3
    );
    assert.deepEqual(params[1], [...command.excluded]);
    // Runs stamped in the last minute may still be committing, so the cutoff lags.
    assert.ok(Date.parse(String(params[4])) <= Date.now() - 60_000);
  }
  assert.equal(
    (await readdir(command.reviewDirectory)).filter((name) =>
      name.startsWith("review-")
    ).length,
    2
  );
});
