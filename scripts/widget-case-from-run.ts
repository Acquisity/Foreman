/**
 * Turn one widget run's session stream into a scrubbed eval case.
 *
 * Usage: pnpm widget:case <wrun_id|front-door run id> <local|preview|production> <short-name> [--output-dir <directory>]
 *
 * Reads the run with the workflow CLI (local runs from `.eve/.workflow-data`),
 * pairs each tool call with its result, replaces every customer identifier, and
 * writes `evals/widget/cases/<short-name>.json` only when the leak check passes.
 * A front-door run (a UUID: it has no session stream) is read from
 * `widget_support_runs` instead, with its conversation's earlier turns as
 * history; point `FOREMAN_MEMORY_DATABASE_URL` at the target's database.
 * It only reads: nothing is written to Vercel, a database or Linear. Raw stream
 * data stays in memory and is never written to disk.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { privateDatabase } from "../agent/lib/private-postgres.js";
import {
  frontDoorQuestion,
  type RunScope,
  scrubCase,
  serializeCase,
  type WidgetCase,
} from "../agent/lib/widget-case.js";
import { widgetContextSchema } from "../agent/lib/widget-scope.js";
import {
  CLI_DEADLINE_MS,
  RUN_ID,
  run,
  streamRun,
  TARGETS,
  type Target,
} from "./widget-run-stream.js";

const FRONT_DOOR_RUN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;
const {
  positionals: [runId, target, name],
  values,
} = parseArgs({
  allowPositionals: true,
  options: { "output-dir": { default: "evals/widget/cases", type: "string" } },
});
const outputDirectory = values["output-dir"];

if (
  !(
    runId &&
    (RUN_ID.test(runId) || FRONT_DOOR_RUN.test(runId)) &&
    TARGETS.includes(target as Target) &&
    name &&
    NAME.test(name)
  )
) {
  console.error(
    "Usage: pnpm widget:case <wrun_id|front-door run id> <local|preview|production> <short-name> [--output-dir <directory>]"
  );
  process.exit(2);
}
const { raw, scope } = FRONT_DOOR_RUN.test(runId)
  ? await frontDoorRun()
  : await streamRun(runId, target as Target);

/** A front-door run: its row and the conversation's earlier turns, oldest first. */
async function frontDoorRun(): Promise<{ raw: WidgetCase; scope: RunScope }> {
  const rows = z
    .array(
      z.object({
        id: z.string(),
        outcome: z
          .object({ message: z.string().nullable(), reason: z.string() })
          .nullable(),
        question: z.string(),
        scope: z.unknown(),
        session_id: z.string().nullable(),
      })
    )
    .parse(
      await privateDatabase(CLI_DEADLINE_MS).query(
        `SELECT r.id, r.question, r.scope, r.session_id, r.outcome
         FROM widget_support_runs target
         JOIN widget_support_runs r ON r.organization_id = target.organization_id
           AND r.conversation_id = target.conversation_id AND r.created_at <= target.created_at
           AND r.scope->>'source' IS DISTINCT FROM 'inbox'
         WHERE target.id = $1
         ORDER BY r.created_at, r.id`,
        [runId]
      )
    );
  const last = rows.at(-1);
  if (!last || last.id !== runId || last.session_id?.startsWith("wrun_")) {
    throw new Error(`${runId} is not a completed front-door run.`);
  }
  const context = z.object(widgetContextSchema.shape).parse(last.scope);
  if (context.source !== "widget") {
    throw new Error(`${runId} is a team inbox run, not a customer widget run.`);
  }
  return {
    raw: {
      cassette: [],
      expectations: {
        cause: null,
        claims: [],
        fileTicket: null,
        foreignIdentifiers: [],
        gateVerdict: null,
        lane: null,
        toolBudget: null,
      },
      question: frontDoorQuestion(
        rows.map((row) => ({
          question: row.question,
          reply: row.outcome?.message ?? null,
        }))
      ),
      scope: { role: context.role, workspace: context.organizationSlug },
      // The run id is a UUID the scrubber would replace, so a front-door case keeps none.
      source: { runId: null, target: target as Target },
      tags: {
        lane: last.outcome?.reason ?? null,
        role: context.role,
        safety: [],
        tools: [],
      },
    },
    scope: context,
  };
}

let text: string;
try {
  text = serializeCase(scrubCase(raw, scope));
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Case not saved:")) {
    console.error("Case conversion refused by leak check.");
    process.exit(3);
  }
  throw error;
}
const path = join(outputDirectory, `${name}.json`);
await mkdir(outputDirectory, { recursive: true });
// Never overwrite: an existing case may hold human-filled expectations.
await writeFile(path, text, { flag: "wx" }).catch(
  (error: NodeJS.ErrnoException) => {
    throw error.code === "EEXIST"
      ? new Error(`${path} already exists. Delete it first to regenerate.`)
      : error;
  }
);
// Biome owns formatting, so a new case passes `pnpm check` as written.
await run("npx", ["biome", "format", "--write", path], {
  timeout: CLI_DEADLINE_MS,
}).catch(async () => {
  await rm(path, { force: true });
  console.error("Case formatting failed.");
  process.exit(4);
});
const largest = Math.max(
  0,
  ...raw.cassette.map((c) => JSON.stringify(c.output).length)
);
console.log(
  `Wrote ${path}: ${raw.cassette.length} tool calls, largest output ${largest} characters.`
);
