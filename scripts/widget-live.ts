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
} from "../agent/lib/widget-live.js";
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
const outputDirectory = `.eve/widget-live/${new Date().toISOString().replace(/[:.]/g, "-")}`;
await mkdir(outputDirectory, { recursive: true });

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
async function reread(tool: string, input: unknown, scope: WidgetContext) {
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
  const dynamic = (await import(`../agent/tools/${tool}.ts`)).default as {
    events: Record<string, (event: unknown, ctx: unknown) => unknown>;
  };
  const resolved = (await dynamic.events["step.started"]({}, ctx)) as {
    execute: (input: unknown, ctx: ToolContext) => unknown;
  } | null;
  if (!resolved) {
    throw new Error(`${tool} is not offered to this scope.`);
  }
  try {
    return await resolved.execute(input, ctx);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The original message through the local server's staff path; the recorded scope is the bearer token. */
async function liveRun(question: string, scope: WidgetContext) {
  const conversationId = randomUUID();
  const post = async (body: object) => {
    const response = await fetch(`${values.server}/internal/widget/message`, {
      body: JSON.stringify({
        conversation_id: conversationId,
        organization_id: scope.organizationId,
        staff: true,
        ...body,
      }),
      headers: {
        authorization: `Bearer ${Buffer.from(JSON.stringify(scope)).toString("base64url")}`,
        "content-type": "application/json",
        [SERVICE_SECRET_HEADER]: process.env.FOREMAN_DIAGNOSTICS_SECRET ?? "",
      },
      method: "POST",
      signal: AbortSignal.timeout(RUN_DEADLINE_MS),
    });
    return (await response.json()) as Record<string, unknown>;
  };
  let result = await post({ ...toRequest(question), message_id: randomUUID() });
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

for (const runId of runIds) {
  // biome-ignore lint/performance/noAwaitInLoops: one case at a time keeps provider load and output readable.
  const { raw, scope } = await streamRun(runId, "production");
  const original = await recordedRun(runId);
  const reads = await Promise.all(
    raw.cassette
      .filter((call) => !NOT_READS.has(call.tool))
      .map(async (call) => ({
        ...call,
        reread: await reread(call.tool, call.input, scope),
      }))
  );
  const drift = driftVerdict(reads);
  const live = await liveRun(
    pinnedQuestion(raw.question, original.sentAt.toISOString()),
    scope
  );
  await writeFile(
    `${outputDirectory}/${runId}.json`,
    `${JSON.stringify({ drift, live, original, question: raw.question, reads, runId }, null, 2)}\n`
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
      ...(drift.unavailable.length
        ? [`unavailable when recorded: ${drift.unavailable.join(", ")}`]
        : []),
      `live: ${live.status} ${live.decision ?? ""}`.trim(),
      "new reply:",
      liveReply,
    ].join("\n")
  );
}
console.log(`\nRaw results: ${outputDirectory}`);
