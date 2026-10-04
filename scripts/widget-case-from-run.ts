/**
 * Turn one widget run's session stream into a scrubbed eval case.
 *
 * Usage: pnpm widget:case <wrun_id> <local|preview|production> <short-name> [--yes]
 *
 * Reads the run with the workflow CLI (local runs from `.eve/.workflow-data`),
 * pairs each tool call with its result, replaces every customer identifier, and
 * writes `evals/widget/cases/<short-name>.json` only when the leak check passes.
 * It only reads: nothing is written to Vercel, a database or Linear. Raw stream
 * data stays in memory and is never written to disk.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { z } from "zod";
import {
  type RunScope,
  scrubCase,
  serializeCase,
  type WidgetCase,
} from "../agent/lib/widget-case.js";
import {
  WIDGET_SUPPORT_ISSUER,
  widgetContextSchema,
} from "../agent/lib/widget-scope.js";

const run = promisify(execFile);
const RUN_ID = /^wrun_[0-9A-Z]{26}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;
const TARGETS = ["local", "preview", "production"] as const;
type Target = (typeof TARGETS)[number];
// ENG-14702: decrypt can hang, so every CLI call has a deadline.
const CLI_DEADLINE_MS = 180_000;

const [runId, target, name] = process.argv.slice(2);
if (
  !(
    runId &&
    RUN_ID.test(runId) &&
    TARGETS.includes(target as Target) &&
    name &&
    NAME.test(name)
  )
) {
  console.error(
    "Usage: pnpm widget:case <wrun_id> <local|preview|production> <short-name> [--yes]"
  );
  process.exit(2);
}
const remote = target !== "local";

const cli = async (args: string[], decrypt = false) => {
  const backend = remote
    ? [
        "-b",
        "vercel",
        "--team",
        "acquisity",
        "--project",
        "foreman",
        "-e",
        target,
      ]
    : ["-b", "local"];
  const { stdout: out } = await run(
    "npx",
    [
      "-y",
      "@workflow/cli@5.0.1",
      "inspect",
      ...args,
      ...backend,
      ...(decrypt && remote ? ["--decrypt"] : []),
      "-j",
    ],
    {
      env: { ...process.env, WORKFLOW_LOCAL_DATA_DIR: ".eve/.workflow-data" },
      maxBuffer: 256 * 1024 * 1024,
      timeout: CLI_DEADLINE_MS,
    }
  );
  return out;
};

interface EveEvent {
  data?: {
    actions?: {
      callId: string;
      input: unknown;
      kind: string;
      toolName: string;
    }[];
    message?: string;
    result?: { callId: string; output: unknown; toolName: string };
    status?: string;
  };
  meta: { at: string };
  type: string;
}

const runRecord = z.object({
  attributes: z.record(z.string(), z.string()).optional(),
  createdAt: z.string(),
  input: z.unknown(),
});

if (target === "production") {
  // The run metadata is readable without a key; its scope is not.
  const meta = runRecord.parse(JSON.parse(await cli(["run", runId])));
  console.log(
    `Run ${runId}, created ${meta.createdAt}, trigger ${meta.attributes?.["$eve.trigger"] ?? "unknown"}.`
  );
  console.log(
    "Its workspace is only known after decrypting. Decrypting is an audit-logged key retrieval."
  );
  if (!process.argv.includes("--yes")) {
    if (!stdin.isTTY) {
      console.error("Not decrypted: pass --yes when stdin is not a terminal.");
      process.exit(1);
    }
    const prompt = createInterface({ input: stdin, output: stdout });
    const answer = await prompt.question("Decrypt this production run? [y/N] ");
    prompt.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.error("Not decrypted.");
      process.exit(1);
    }
  }
}

const streams = z
  .array(z.object({ streamId: z.string() }))
  .parse(JSON.parse(await cli(["streams", "-r", runId])));
const streamId = streams.find((s) => s.streamId.endsWith("_user"))?.streamId;
if (!streamId) {
  throw new Error(`No session stream for ${runId}.`);
}

// Each CLI line is one chunk serialized as an object of byte values.
const bytes = (await cli(["stream", streamId, `--run=${runId}`], true))
  .split("\n")
  .filter((line) => line.trim())
  .flatMap((line) => Object.values(JSON.parse(line) as Record<string, number>));
const events = Buffer.from(bytes)
  .toString("utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as EveEvent);
if (!events.length) {
  throw new Error(
    `The stream for ${runId} came back empty (see ENG-14702). Nothing was written.`
  );
}

// The verified widget scope is the session auth eve keeps in the run input.
const { input } = runRecord.parse(JSON.parse(await cli(["run", runId], true)));
const auth = z
  .tuple([
    z.object({
      serializedContext: z.object({
        "eve.auth": z.object({ attributes: z.unknown(), issuer: z.string() }),
      }),
    }),
  ])
  .rest(z.unknown())
  .parse(input)[0].serializedContext["eve.auth"];
if (auth.issuer !== WIDGET_SUPPORT_ISSUER) {
  throw new Error(`${runId} is not a widget support run.`);
}
const context = z.object(widgetContextSchema.shape).parse(auth.attributes);
if (context.source !== "widget") {
  throw new Error(`${runId} is a team inbox run, not a customer widget run.`);
}
const scope: RunScope = context;

const question = events.find((e) => e.type === "message.received")?.data
  ?.message;
if (!question) {
  throw new Error(`${runId} has no customer message.`);
}
const results = new Map(
  events
    .filter((e) => e.type === "action.result" && e.data?.result)
    .map((e) => [e.data?.result?.callId, e])
);
const cassette = events
  .filter((e) => e.type === "actions.requested")
  .flatMap((e) =>
    (e.data?.actions ?? [])
      .filter((action) => action.kind === "tool-call")
      .map((action) => {
        const result = results.get(action.callId);
        if (!result?.data?.result) {
          throw new Error(`${action.toolName} has no result in the stream.`);
        }
        return {
          input: action.input,
          output: result.data.result.output,
          requestedAt: e.meta.at,
          resultAt: result.meta.at,
          status: result.data.status ?? "unknown",
          tool: action.toolName,
        };
      })
  );

const raw: WidgetCase = {
  cassette,
  expectations: {
    cause: null,
    claims: [],
    fileTicket: null,
    gateVerdict: null,
    lane: null,
    toolBudget: null,
  },
  question,
  scope: { role: context.role, workspace: context.organizationSlug },
  source: { runId, target: target as Target },
  tags: {
    lane: null,
    role: context.role,
    safety: [],
    tools: [...new Set(cassette.map((call) => call.tool))],
  },
};
const text = serializeCase(scrubCase(raw, scope));
const path = `evals/widget/cases/${name}.json`;
await mkdir("evals/widget/cases", { recursive: true });
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
});
const largest = Math.max(
  0,
  ...cassette.map((c) => JSON.stringify(c.output).length)
);
console.log(
  `Wrote ${path}: ${cassette.length} tool calls, largest output ${largest} characters.`
);
