/**
 * Re-run production widget investigations live, read-only (ENG-15026).
 *
 * Usage: pnpm widget:live <wrun_id...> [--server <eve dev url>]
 *
 * For each production run: read its customer message, scope and tool calls
 * from the session stream, and its reply and date from `widget_support_runs`
 * (FOREMAN_MEMORY_DATABASE_URL from `.env.prod-reader`). Re-issue each recorded
 * read with the same input and compare (drift), then send the original message,
 * pinned to its date, through the staff path of a local `eve dev` started with
 * WIDGET_LIVE=1, where every read is live and widget_file_ticket files nothing.
 * Raw results go to the gitignored `.eve/widget-live/<timestamp>/`; printed
 * output has customer identifiers replaced.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getToken as getConnectToken } from "@vercel/connect";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { privateDatabase } from "../agent/lib/private-postgres.js";
import {
  findLeaks,
  scrubCase,
  toRequest,
  type WidgetCase,
} from "../agent/lib/widget-case.js";
import {
  driftVerdict,
  gapSentences,
  NOT_READS,
  pinnedQuestion,
  type ReadResult,
  readResult,
} from "../agent/lib/widget-live.js";
import {
  hasMovingWindow,
  liveServerUrl,
  verifyLiveServer,
} from "../agent/lib/widget-live-policy.js";
import { type WidgetContext, widgetAuth } from "../agent/lib/widget-scope.js";
import { SERVICE_SECRET_HEADER } from "../agent/lib/widget-service-secret.js";
import { RUN_ID, streamRun } from "./widget-run-stream.js";

const POLL_MS = 3000;
const RUN_DEADLINE_MS = 600_000;
const READ_DEADLINE_MS = 120_000;
const TOOL_NAME = /^widget_[a-z_]{1,60}$/;

const { positionals: runIds, values } = parseArgs({
  allowPositionals: true,
  options: { server: { default: "http://localhost:2000", type: "string" } },
});
if (!(runIds.length && runIds.every((id) => RUN_ID.test(id)))) {
  console.error(
    "Usage: pnpm widget:live <wrun_id...> [--server <eve dev url>]"
  );
  process.exit(2);
}
if (
  process.env.WIDGET_LIVE === "1" ||
  process.env.WIDGET_REPLAY === "1" ||
  process.env.WIDGET_REPLAY_CASE
) {
  throw new Error(
    "Set live/replay flags on the dev server only; the runner requires ordinary exact-input reads."
  );
}
const server = liveServerUrl(values.server);
await verifyLiveServer(server, process.env.FOREMAN_DIAGNOSTICS_SECRET ?? "");
const outputDirectory = `.eve/widget-live/${new Date().toISOString().replace(/[:.]/g, "-")}`;
await mkdir(outputDirectory, { mode: 0o700, recursive: true });

/** The production run's reply and when it was asked. */
async function recordedRun(runId: string) {
  const [row] = z
    .array(
      z.object({
        created_at: z.coerce.date(),
        outcome: z.object({ message: z.string().nullable() }).nullable(),
      })
    )
    .parse(
      await privateDatabase(30_000).query(
        "SELECT created_at, outcome FROM widget_support_runs WHERE session_id = $1 LIMIT 1",
        [runId]
      )
    );
  if (!row) {
    throw new Error(`${runId} has no widget_support_runs row.`);
  }
  return { reply: row.outcome?.message ?? null, sentAt: row.created_at };
}

/** The authored tool as eve resolves it for this scope, called once with the recorded input. */
async function reread(
  tool: string,
  input: unknown,
  scope: WidgetContext
): Promise<ReadResult> {
  if (!TOOL_NAME.test(tool)) {
    throw new Error(`Unexpected tool ${tool}.`);
  }
  const connector = process.env.EXECUTOR_MCP_CONNECTOR ?? "";
  const auth = widgetAuth(scope);
  const ctx = {
    abortSignal: AbortSignal.timeout(READ_DEADLINE_MS),
    // Outside a session there is no ctx.getToken, so the Executor app token is
    // read the way the widget egress gate reads it.
    getToken: async () => ({
      token: await getConnectToken(connector, { subject: { type: "app" } }),
    }),
    session: { auth: { current: auth, initiator: auth } },
  } as unknown as ToolContext;
  try {
    const dynamic = (await import(`../agent/tools/${tool}.ts`)).default as {
      events: Record<string, (event: unknown, ctx: unknown) => unknown>;
    };
    const resolved = (await dynamic.events["step.started"]({}, ctx)) as {
      execute: (input: unknown, ctx: ToolContext) => unknown;
    } | null;
    return resolved
      ? readResult(await resolved.execute(input, ctx))
      : { status: "unverifiable" };
  } catch {
    return { status: "unverifiable" };
  }
}

/** The original message through the local server's staff path; the recorded scope is the bearer token. */
async function liveRun(question: string, scope: WidgetContext, sentAt: string) {
  const conversationId = randomUUID();
  const post = async (body: object) => {
    const response = await fetch(`${server}/internal/widget/message`, {
      body: JSON.stringify({
        conversation_id: conversationId,
        organization_id: scope.organizationId,
        staff: true,
        ...body,
      }),
      headers: {
        authorization: `Bearer ${Buffer.from(JSON.stringify({ scope, sentAt })).toString("base64url")}`,
        "content-type": "application/json",
        [SERVICE_SECRET_HEADER]: process.env.FOREMAN_DIAGNOSTICS_SECRET ?? "",
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(RUN_DEADLINE_MS),
    });
    if (!response.ok) {
      throw new Error("The local live investigation request failed.");
    }
    return (await response.json()) as Record<string, unknown>;
  };
  const originalRequest = toRequest(question);
  let result = await post({
    ...originalRequest,
    message_id: randomUUID(),
    question: pinnedQuestion(originalRequest.question, sentAt),
  });
  const deadline = Date.now() + RUN_DEADLINE_MS;
  while (result.status === "pending" && Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: each poll waits for the previous one.
    await sleep(POLL_MS);
    result = await post({ action: "result", run_id: result.run_id });
  }
  return result;
}

/** Printed text with every customer identifier replaced, or a notice when the scrubber cannot clear it. */
function redacted(raw: WidgetCase, scope: WidgetContext, texts: string[]) {
  const replies = texts.map((text, index) => ({
    input: null,
    output: text,
    requestedAt: new Date(0).toISOString(),
    resultAt: new Date(0).toISOString(),
    status: "printed",
    tool: `printed_${index}`,
  }));
  const scrubbed = scrubCase(
    { ...raw, cassette: [...raw.cassette, ...replies] },
    scope
  );
  if (findLeaks(scrubbed).length) {
    return texts.map(
      () =>
        `[withheld: identifiers left after redaction; see ${outputDirectory}]`
    );
  }
  return scrubbed.case.cassette
    .slice(-texts.length)
    .map((entry) => String(entry.output));
}

async function rerun(runId: string) {
  const { raw, scope } = await streamRun(runId, "production");
  const original = await recordedRun(runId);
  const reads = await Promise.all(
    raw.cassette
      .filter((call) => !NOT_READS.has(call.tool))
      .map(async (call) => ({
        ...call,
        movingWindow: hasMovingWindow(call.tool, call.input),
        recorded: readResult(call.output, call.status),
        reread: await reread(call.tool, call.input, scope),
      }))
  );
  const drift = driftVerdict(reads);
  const live = await liveRun(
    raw.question,
    scope,
    original.sentAt.toISOString()
  );
  await writeFile(
    `${outputDirectory}/${runId}.json`,
    `${JSON.stringify({ drift, live, original, question: raw.question, reads, runId }, null, 2)}\n`,
    { mode: 0o600 }
  );
  const gaps = gapSentences(original.reply);
  const [liveReply, ...printedGaps] = redacted(raw, scope, [
    typeof live.message === "string"
      ? live.message
      : `(no reply: ${live.status})`,
    ...gaps,
  ]);
  console.log(
    [
      `\n=== ${runId} (asked ${original.sentAt.toISOString().slice(0, 10)})`,
      "capability: (blank until the ENG-15024 classifier is wired)",
      "could not confirm, originally:",
      ...(printedGaps.length
        ? printedGaps.map((gap) => `  - ${gap}`)
        : ["  (none found)"]),
      `drift: ${drift.verdict}${drift.changed.length ? ` (${drift.changed.join(", ")})` : ""}, ${drift.compared} of ${reads.length} reads compared`,
      ...(drift.unverifiable.length
        ? [`unverifiable reads: ${drift.unverifiable.join(", ")}`]
        : []),
      ...(drift.partial.length
        ? [
            `partly unavailable reads (compared, cannot prove steady): ${drift.partial.join(", ")}`,
          ]
        : []),
      `cause: ${drift.causeGradeAllowed ? "eligible once the classifier is wired" : "not graded"}`,
      ...reads
        .filter((read) => read.movingWindow)
        .map(
          (read) =>
            `implicit moving window when recorded: ${read.tool}; exact-input drift re-read is current, historical evidence is pinned only in the new investigation`
        ),
      `live: ${live.status} ${live.decision ?? ""}`.trim(),
      "new reply:",
      liveReply,
    ].join("\n")
  );
}

let failures = 0;
for (const runId of runIds) {
  try {
    // biome-ignore lint/performance/noAwaitInLoops: one case at a time keeps provider load and output readable.
    await rerun(runId);
  } catch {
    // A fixed class, never the error text: it can carry customer data.
    failures += 1;
    await writeFile(
      `${outputDirectory}/${runId}.json`,
      `${JSON.stringify({ failed: "run_failed", runId }, null, 2)}\n`,
      { mode: 0o600 }
    );
    console.log(`\n=== ${runId}: failed (run_failed); continuing`);
  }
}
console.log(`\nRaw results: ${outputDirectory}`);
if (failures) {
  process.exitCode = 1;
}
