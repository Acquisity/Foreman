/**
 * Re-run production widget investigations live, read-only (ENG-15026).
 *
 * Usage: pnpm widget:live <wrun_id...> [--server <eve dev url>]
 *        pnpm widget:live score [--set <name>] [--pick 20] [--server <eve dev url>]
 *        pnpm widget:live rejudge --from <score result directory>
 *
 * For each production run: read its customer message, scope and tool calls
 * from the session stream, and its reply and date from `widget_support_runs`
 * (FOREMAN_MEMORY_DATABASE_URL from `.env.prod-reader`). Re-issue each recorded
 * read with the same input and compare (drift), then send the original message,
 * pinned to its date, through the staff path of a local `eve dev` started with
 * WIDGET_LIVE=1, where every read is live and widget_file_ticket files nothing.
 * Raw results go to the gitignored `.eve/widget-live/<timestamp>/`; printed
 * output has customer identifiers replaced.
 *
 * `score` picks (or reuses) a set of recent production investigations,
 * snapshots each under `.eve/widget-live/sets/<name>/`, re-runs every case
 * live, judges each reply with the replay judge and no authored expectations,
 * and prints the scorecard (ENG-15044 round 7).
 *
 * `rejudge` re-asks the judge only for needs_human on a saved score result,
 * keeping every other verdict, and prints the scorecard and each changed
 * handoff verdict (ENG-15044 round 8c). It runs nothing live.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getToken as getConnectToken } from "@vercel/connect";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { privateDatabase } from "../agent/lib/private-postgres.js";
import {
  candidateRowSchema,
  parseExcludedOrgs,
} from "../agent/lib/widget-candidates.js";
import {
  findLeaks,
  scrubCase,
  toRequest,
  type WidgetCase,
} from "../agent/lib/widget-case.js";
import {
  answeredLane,
  handedOff,
  leaks,
  rawFields,
} from "../agent/lib/widget-graders.js";
import {
  citedArticles,
  claimsFor,
  type JudgeRecord,
  judgeAnswer,
  type ReplayRow,
  readRecords,
  renderScorecard,
  reviewedSample,
  type ScoredReplay,
  saveRecord,
  scorecard,
} from "../agent/lib/widget-judge.js";
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
import {
  type ConversationExport,
  DEFAULT_PICK,
  exportVerdicts,
  LIVE_SET_QUERY,
  LIVE_SETS,
  LIVE_TARGETS,
  type LiveSet,
  type LiveSnapshot,
  liveCase,
  liveScorecard,
  liveSetSchema,
  NEEDS_HUMAN,
  rankSet,
  splitNeedsHuman,
  twoColumnScorecard,
} from "../agent/lib/widget-live-score.js";
import { MAX_WIDGET_TOOL_CALLS } from "../agent/lib/widget-next-action.js";
import { replyElapsed } from "../agent/lib/widget-replay-timing.js";
import { widgetRunSchema } from "../agent/lib/widget-run-store.js";
import { type WidgetContext, widgetAuth } from "../agent/lib/widget-scope.js";
import { SERVICE_SECRET_HEADER } from "../agent/lib/widget-service-secret.js";
import { RUN_ID, streamRun } from "./widget-run-stream.js";

const POLL_MS = 3000;
const RUN_DEADLINE_MS = 600_000;
const READ_DEADLINE_MS = 120_000;
const TOOL_NAME = /^widget_[a-z_]{1,60}$/;

const SET_NAME = /^[\w-]{1,64}$/;

const { positionals: runIds, values } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: "string" },
    pick: { default: String(DEFAULT_PICK), type: "string" },
    server: { default: "http://localhost:2000", type: "string" },
    set: { type: "string" },
  },
});
const scoring = runIds[0] === "score" && runIds.length === 1;
const rejudging =
  runIds[0] === "rejudge" && runIds.length === 1 && Boolean(values.from);
const pick = Number(values.pick);
if (
  !(
    rejudging ||
    (scoring &&
      Number.isInteger(pick) &&
      pick > 0 &&
      (!values.set || SET_NAME.test(values.set))) ||
    (runIds.length && runIds.every((id) => RUN_ID.test(id)))
  )
) {
  console.error(
    "Usage: pnpm widget:live <wrun_id...> [--server <eve dev url>]\n       pnpm widget:live score [--set <name>] [--pick 20] [--server <eve dev url>]\n       pnpm widget:live rejudge --from <score result directory>"
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
if (!rejudging) {
  await verifyLiveServer(server, process.env.FOREMAN_DIAGNOSTICS_SECRET ?? "");
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const setName = values.set ?? stamp.slice(0, 10);
const from = (values.from ?? "").replace(/\/+$/, "");
let outputDirectory = `.eve/widget-live/${stamp}`;
if (rejudging) {
  outputDirectory = `${from}/rejudge-${stamp}`;
} else if (scoring) {
  outputDirectory = `${LIVE_SETS}/${setName}/${stamp}`;
}
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
  const sent = Date.now();
  let result = await post({
    ...originalRequest,
    message_id: randomUUID(),
    question: pinnedQuestion(originalRequest.question, sentAt),
  });
  const deadline = Date.now() + RUN_DEADLINE_MS;
  // Measured at the 3-second poll, like replay.
  let firstReplyMs = replyElapsed(result, sent, Date.now());
  while (result.status === "pending" && Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: each poll waits for the previous one.
    await sleep(POLL_MS);
    result = await post({ action: "result", run_id: result.run_id });
    firstReplyMs ??= replyElapsed(result, sent, Date.now());
  }
  return {
    finalReplyMs: result.status === "pending" ? null : Date.now() - sent,
    firstReplyMs,
    result,
  };
}

/** The case and texts with every customer identifier replaced, or null when the scrubber cannot clear them. */
function scrubTexts(raw: WidgetCase, scope: WidgetContext, texts: string[]) {
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
    return null;
  }
  const { cassette } = scrubbed.case;
  return {
    case: {
      ...scrubbed.case,
      cassette: cassette.slice(0, raw.cassette.length),
    },
    texts: cassette
      .slice(raw.cassette.length)
      .map((entry) => String(entry.output)),
  };
}

const WITHHELD = `[withheld: identifiers left after redaction; see ${outputDirectory}]`;

/** Printed text with every customer identifier replaced, or a notice when the scrubber cannot clear it. */
const redacted = (raw: WidgetCase, scope: WidgetContext, texts: string[]) =>
  scrubTexts(raw, scope, texts)?.texts ?? texts.map(() => WITHHELD);

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
  const { result: live } = await liveRun(
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

/** Pick a set from production and snapshot each run while its stream still exists. */
async function pickSet(path: string): Promise<LiveSet> {
  const rows = z
    .array(candidateRowSchema)
    .parse(
      await privateDatabase(30_000).query(LIVE_SET_QUERY, [
        [...parseExcludedOrgs(process.env.WIDGET_CANDIDATES_EXCLUDE_ORGS)],
      ])
    );
  const cases: LiveSnapshot[] = [];
  for (const { row, topic } of rankSet(rows)) {
    if (cases.length >= pick) {
      break;
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one production decrypt at a time bounds CLI load.
      const { raw, scope } = await streamRun(
        row.session_id ?? "",
        "production"
      );
      cases.push({
        cassette: raw.cassette,
        question: raw.question,
        reason: row.outcome?.reason ?? null,
        reply: row.outcome?.message ?? null,
        runId: row.session_id ?? "",
        scope,
        sentAt: row.created_at.toISOString(),
        topic,
      });
      console.log(`Snapshotted ${row.session_id} (${topic}).`);
    } catch {
      // A fixed class, never the error text: it can carry customer data.
      console.log(`Skipped ${row.session_id}: snapshot_failed.`);
    }
  }
  const set = liveSetSchema.parse({
    cases,
    pickedAt: new Date().toISOString(),
  });
  await writeFile(path, `${JSON.stringify(set, null, 2)}\n`, { mode: 0o600 });
  return set;
}

/** The local store's row for a live run: its session, reason and citations. */
async function liveStoreRun(id: string) {
  const entries = z
    .array(z.object({ run: widgetRunSchema }))
    .parse(
      JSON.parse(await readFile(".eve/widget-live/runs/store.json", "utf8"))
    );
  const entry = entries.find(({ run }) => run.id === id);
  if (!entry) {
    throw new Error("The live run is not in the local store.");
  }
  return entry.run;
}

interface Scored {
  conversation: ConversationExport;
  production: ScoredReplay;
  replay: ScoredReplay;
}

/** Judge one live reply: the replay claims plus needs_human, or needs_human alone when nothing was sent. */
async function judgeLive(
  name: string,
  scrubbed: WidgetCase,
  answer: string | null,
  citations: string[],
  directory = outputDirectory
) {
  const articles = await citedArticles(citations);
  if (!answer) {
    const { verdicts } = await judgeAnswer(
      scrubbed,
      "(No message was sent to the customer.)",
      [NEEDS_HUMAN],
      undefined,
      undefined,
      articles
    );
    const { needsHuman, reason } = splitNeedsHuman(verdicts);
    return { needsHuman, reason, record: null };
  }
  const judged = await judgeAnswer(
    scrubbed,
    answer,
    [...claimsFor(scrubbed), NEEDS_HUMAN],
    undefined,
    undefined,
    articles
  );
  const { needsHuman, reason, verdicts } = splitNeedsHuman(judged.verdicts);
  const record: JudgeRecord = reviewedSample(
    name,
    scrubbed,
    answer,
    verdicts,
    judged.gaps
  );
  saveRecord(directory, record);
  return { needsHuman, reason, record };
}

/** Re-run one snapshot live; the judge call is returned unawaited so the next live run can start. */
async function scoreCase(snapshot: LiveSnapshot) {
  const { finalReplyMs, firstReplyMs, result } = await liveRun(
    snapshot.question,
    snapshot.scope,
    snapshot.sentAt
  );
  if (result.status !== "completed") {
    throw new Error("The live run did not complete.");
  }
  const run = await liveStoreRun(String(result.run_id));
  const cassette = run.session_id
    ? (await streamRun(run.session_id, "local", true)).raw.cassette
    : [];
  const tools = cassette.map(({ tool }) => tool);
  const message = run.outcome?.message ?? null;
  const citations = (run.outcome?.citations ?? []).map(({ url }) => url);
  const raw = liveCase({
    cassette,
    question: snapshot.question,
    runId: snapshot.runId,
    scope: {
      role: snapshot.scope.role,
      workspace: snapshot.scope.organizationSlug,
    },
  });
  const row = {
    answer: message,
    budgetHit: tools.length >= MAX_WIDGET_TOOL_CALLS,
    citations,
    finalReplyMs,
    firstReplyMs,
    handedOff: handedOff(answeredLane(run), run.outcome?.reason ?? null, tools),
    leaks: leaks(message, raw).length ? "fail" : "pass",
    rawFields: rawFields(message).length ? "fail" : "pass",
    scored: true,
  };
  await writeFile(
    `${outputDirectory}/${snapshot.runId}.json`,
    `${JSON.stringify({ cassette, liveRun: run, row, runId: snapshot.runId }, null, 2)}\n`,
    { mode: 0o600 }
  );
  // Returned unawaited so the next live run starts while this one is judged.
  const pending = judgeCase(snapshot, cassette, row, judgeLive);
  pending.catch(() => undefined);
  return { pending };
}

/** Judge a live run's reply and the original production reply the same way. */
function judgeCase(
  snapshot: LiveSnapshot,
  cassette: WidgetCase["cassette"],
  row: ReplayRow,
  judge: typeof judgeLive
): Promise<Scored> {
  const tools = cassette.map(({ tool }) => tool);
  const message = row.answer ?? null;
  const citations = row.citations ?? [];
  const scope = {
    role: snapshot.scope.role,
    workspace: snapshot.scope.organizationSlug,
  };
  const raw = liveCase({
    cassette,
    question: snapshot.question,
    runId: snapshot.runId,
    scope,
  });
  const scrubbed = scrubTexts(raw, snapshot.scope, [
    message ?? "",
    snapshot.reply ?? "",
  ]);
  // The original reply, judged the same way against its own production tool results.
  const productionRaw = liveCase({
    cassette: snapshot.cassette,
    question: snapshot.question,
    runId: snapshot.runId,
    scope,
  });
  const productionTools = snapshot.cassette.map(({ tool }) => tool);
  const productionRow = {
    answer: snapshot.reply,
    budgetHit: productionTools.length >= MAX_WIDGET_TOOL_CALLS,
    citations: [],
    finalReplyMs: null,
    firstReplyMs: null,
    handedOff:
      snapshot.reason === undefined
        ? undefined
        : handedOff("investigate", snapshot.reason, productionTools),
    leaks: leaks(snapshot.reply, productionRaw).length ? "fail" : "pass",
    rawFields: rawFields(snapshot.reply).length ? "fail" : "pass",
    scored: true,
  };
  const productionScrubbed = scrubTexts(productionRaw, snapshot.scope, [
    snapshot.reply ?? "",
  ]);
  const judgeOrMissing = async (
    texts: typeof scrubbed,
    answer: string | null,
    urls: string[],
    directory: string
  ): ReturnType<typeof judgeLive> => {
    if (texts) {
      try {
        return await judge(
          snapshot.runId,
          texts.case,
          answer && (texts.texts[0] ?? null),
          urls,
          directory
        );
      } catch {
        console.log(`${snapshot.runId}: judge_failed (missing coverage)`);
      }
    }
    return { needsHuman: undefined, reason: null, record: null };
  };
  const judging = async (): Promise<Scored> => {
    const [judged, original] = await Promise.all([
      judgeOrMissing(scrubbed, message, citations, outputDirectory),
      judgeOrMissing(
        productionScrubbed,
        snapshot.reply,
        [],
        `${outputDirectory}/production`
      ),
    ]);
    const request = toRequest(scrubbed?.case.question ?? WITHHELD);
    return {
      conversation: {
        customer: [
          ...(request.history ?? []),
          { role: "customer", text: request.question },
        ],
        liveReply: message && (scrubbed?.texts[0] ?? WITHHELD),
        newToolCalls: tools,
        originalReply: snapshot.reply && (scrubbed?.texts[1] ?? WITHHELD),
        originalToolCalls: productionTools,
        originalVerdicts: exportVerdicts(original.record, {
          reason: original.reason,
          value: original.needsHuman,
        }),
        runId: snapshot.runId,
        topic: snapshot.topic,
        verdicts: exportVerdicts(judged.record, {
          reason: judged.reason,
          value: judged.needsHuman,
        }),
      },
      production: {
        caseName: snapshot.runId,
        record: original.record,
        recorded: liveCase(
          {
            cassette: snapshot.cassette,
            question: snapshot.question,
            runId: snapshot.runId,
            scope,
          },
          original.needsHuman
        ),
        row: productionRow,
        runDir: `${outputDirectory}/production`,
      },
      replay: {
        caseName: snapshot.runId,
        record: judged.record,
        recorded: liveCase(
          {
            cassette,
            question: snapshot.question,
            runId: snapshot.runId,
            scope,
          },
          judged.needsHuman
        ),
        row,
        runDir: outputDirectory,
      },
    };
  };
  return judging();
}

async function score() {
  const setPath = `${LIVE_SETS}/${setName}/set.json`;
  const set = existsSync(setPath)
    ? liveSetSchema.parse(JSON.parse(await readFile(setPath, "utf8")))
    : await pickSet(setPath);
  console.log(
    `Set ${setName}: ${set.cases.length} cases picked ${set.pickedAt}.`
  );
  const judged: { pending: Promise<Scored>; runId: string }[] = [];
  const failed: string[] = [];
  for (const snapshot of set.cases) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one live run at a time keeps provider load and the local store readable.
      const { pending } = await scoreCase(snapshot);
      judged.push({ pending, runId: snapshot.runId });
      console.log(`Re-ran ${snapshot.runId} (${snapshot.topic}).`);
    } catch {
      // A fixed class, never the error text: it can carry customer data.
      failed.push(snapshot.runId);
      console.log(`${snapshot.runId}: run_failed; continuing`);
    }
  }
  const done: Scored[] = [];
  for (const { pending, runId } of judged) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: these are already running; this only collects them in order.
      done.push(await pending);
    } catch {
      failed.push(runId);
    }
  }
  await report(
    done,
    `Live set ${setName}, ${done.length} of ${set.cases.length} re-run (run_failed: ${failed.join(", ") || "none"}).`
  );
  failures = failed.length;
}

/** Write and print the two-column scorecard and the review export. */
async function report(done: Scored[], heading: string) {
  const live = liveScorecard(scorecard(done.map(({ replay }) => replay)));
  const production = liveScorecard(
    scorecard(done.map(({ production: original }) => original))
  );
  const text = [
    heading,
    "",
    twoColumnScorecard(production, live),
    "",
    "## Live at HEAD",
    "",
    renderScorecard(live, LIVE_TARGETS),
    "## Production (the original replies)",
    "",
    renderScorecard(production, LIVE_TARGETS),
  ].join("\n");
  await writeFile(`${outputDirectory}/scorecard.md`, text, { mode: 0o600 });
  await writeFile(
    `${outputDirectory}/conversations.json`,
    `${JSON.stringify(
      done.map(({ conversation }) => conversation),
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  console.log(`\n${text}`);
}

const NO_MESSAGE = "(No message was sent to the customer.)";
const savedRunSchema = z.object({
  cassette: z.array(z.unknown()),
  row: z.record(z.string(), z.unknown()),
});
const savedVerdictsSchema = z.array(
  z.object({
    originalVerdicts: z.array(
      z.object({ goal: z.string(), verdict: z.string() })
    ),
    runId: z.string(),
    verdicts: z.array(z.object({ goal: z.string(), verdict: z.string() })),
  })
);

/** Re-judge needs_human alone on a saved score result, keeping its other verdicts; nothing runs live. */
async function rejudge() {
  const set = liveSetSchema.parse(
    JSON.parse(await readFile(`${from}/../set.json`, "utf8"))
  );
  const before = new Map(
    savedVerdictsSchema
      .parse(JSON.parse(await readFile(`${from}/conversations.json`, "utf8")))
      .map((saved) => [saved.runId, saved])
  );
  const needsHumanOnly: typeof judgeLive = async (
    name,
    scrubbed,
    answer,
    citations,
    directory = outputDirectory
  ) => {
    const record =
      readRecords(directory.replace(outputDirectory, from)).find(
        (saved) => saved.case === name
      ) ?? null;
    const { verdicts } = await judgeAnswer(
      scrubbed,
      answer ?? NO_MESSAGE,
      [NEEDS_HUMAN],
      undefined,
      undefined,
      await citedArticles(citations)
    );
    if (record) {
      saveRecord(directory, record);
    }
    const { needsHuman, reason } = splitNeedsHuman(verdicts);
    return { needsHuman, reason, record };
  };
  const runs = set.cases.filter((snapshot) =>
    existsSync(`${from}/${snapshot.runId}.json`)
  );
  const done = await Promise.all(
    runs.map(async (snapshot) => {
      const { cassette, row } = savedRunSchema.parse(
        JSON.parse(await readFile(`${from}/${snapshot.runId}.json`, "utf8"))
      );
      return judgeCase(
        snapshot,
        cassette as WidgetCase["cassette"],
        row as ReplayRow,
        needsHumanOnly
      );
    })
  );
  await report(
    done,
    `Live set ${setName}, ${from} re-judged for needs_human only (${done.length} of ${set.cases.length} saved).`
  );
  const verdictIn = (list: { goal: string; verdict: string }[] | undefined) =>
    list?.find(({ goal }) => goal === NEEDS_HUMAN.id)?.verdict ?? "missing";
  console.log("\nChanged needs_human verdicts:");
  let changed = 0;
  for (const { conversation, production, replay } of done) {
    const old = before.get(conversation.runId);
    for (const [side, scored, oldList, newList] of [
      [
        "production",
        production,
        old?.originalVerdicts,
        conversation.originalVerdicts,
      ],
      ["live", replay, old?.verdicts, conversation.verdicts],
    ] as const) {
      const was = verdictIn(oldList);
      const now = verdictIn(newList);
      if (was !== now) {
        changed += 1;
        const handed = scored.row.handedOff;
        const grade = (verdict: string) =>
          handed === undefined || verdict === "missing"
            ? "n/a"
            : String(handed === (verdict === "yes"));
        const reason = newList.find(
          ({ goal }) => goal === NEEDS_HUMAN.id
        )?.reason;
        console.log(
          `${conversation.runId} ${side}: needs_human ${was} -> ${now}, handed off ${handed ?? "unknown"}, goal pass ${grade(was)} -> ${grade(now)}: ${reason ?? ""}`
        );
      }
    }
  }
  if (!changed) {
    console.log("none");
  }
}

let failures = 0;
if (rejudging) {
  await rejudge();
} else if (scoring) {
  await score();
}
for (const runId of scoring || rejudging ? [] : runIds) {
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
