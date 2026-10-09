/**
 * Read one widget run's session stream with the workflow CLI (local runs from
 * `.eve/.workflow-data`): its customer message, verified scope and each tool
 * call paired with its result. Shared by `widget:case` and `widget:live`. Raw
 * stream data stays in memory.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { WidgetCase } from "../agent/lib/widget-case.js";
import {
  WIDGET_SUPPORT_ISSUER,
  type WidgetContext,
  widgetContextSchema,
} from "../agent/lib/widget-scope.js";

export const run = promisify(execFile);
export const RUN_ID = /^wrun_[0-9A-Z]{26}$/;
export const TARGETS = ["local", "preview", "production"] as const;
export type Target = (typeof TARGETS)[number];
// ENG-14702: decrypt can hang, so every CLI call has a deadline.
export const CLI_DEADLINE_MS = 180_000;

const cli = async (target: Target, args: string[], decrypt = false) => {
  const remote = target !== "local";
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

export async function streamRun(
  runId: string,
  target: Target
): Promise<{ raw: WidgetCase; scope: WidgetContext }> {
  const streams = z
    .array(z.object({ streamId: z.string() }))
    .parse(JSON.parse(await cli(target, ["streams", "-r", runId])));
  const streamId = streams.find((s) => s.streamId.endsWith("_user"))?.streamId;
  if (!streamId) {
    throw new Error(`No session stream for ${runId}.`);
  }

  // Each CLI line is one chunk serialized as an object of byte values.
  const bytes = (
    await cli(target, ["stream", streamId, `--run=${runId}`], true)
  )
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) =>
      Object.values(JSON.parse(line) as Record<string, number>)
    );
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
  const { input } = runRecord.parse(
    JSON.parse(await cli(target, ["run", runId], true))
  );
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

  return {
    raw: {
      cassette,
      expectations: {
        cause: null,
        claims: [],
        fileTicket: null,
        foreignIdentifiers: [],
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
    } satisfies WidgetCase,
    scope: context,
  };
}
