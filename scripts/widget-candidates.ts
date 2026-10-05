/** Read-only production candidate pull; raw reviews and recovery state stay in .eve/. */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { privateDatabase } from "../agent/lib/private-postgres.js";
import { pullCandidates } from "../agent/lib/widget-candidate-pull.js";
import {
  CANDIDATES_OUTPUT,
  parseExcludedOrgs,
} from "../agent/lib/widget-candidates.js";

const run = promisify(execFile);
const PENDING = "evals/widget/cases-pending";
const QUERY_DEADLINE_MS = 30_000;
// The converter makes up to four 180s CLI calls of its own.
const CONVERTER_DEADLINE_MS = 900_000;

const { values } = parseArgs({
  options: { "exclude-orgs": { type: "string" }, since: { type: "string" } },
});
const excluded = parseExcludedOrgs(
  [values["exclude-orgs"], process.env.WIDGET_CANDIDATES_EXCLUDE_ORGS]
    .filter(Boolean)
    .join(",")
);
await mkdir(CANDIDATES_OUTPUT, { recursive: true });
await mkdir(PENDING, { recursive: true });
await pullCandidates(
  {
    excluded,
    pendingDirectory: PENDING,
    reviewDirectory: CANDIDATES_OUTPUT,
    since: values.since
      ? z.coerce.date().parse(values.since).toISOString()
      : undefined,
  },
  {
    convert: async (sessionId, name, directory) => {
      await run(
        "npx",
        [
          "tsx",
          "scripts/widget-case-from-run.ts",
          sessionId,
          "production",
          name,
          "--output-dir",
          directory,
        ],
        { maxBuffer: 16 * 1024 * 1024, timeout: CONVERTER_DEADLINE_MS }
      );
    },
    log: console.log,
    query: (sql, params) =>
      privateDatabase(QUERY_DEADLINE_MS).query(sql, params),
  }
).catch(async (error: unknown) => {
  await writeFile(`${CANDIDATES_OUTPUT}/pull-failure.txt`, String(error));
  console.error(`Pull failed. See ${CANDIDATES_OUTPUT}/pull-failure.txt.`);
  process.exitCode = 1;
});
