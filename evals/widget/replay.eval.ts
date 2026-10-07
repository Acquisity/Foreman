import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  defineEval,
  type EveEvalContext,
  type EveEvalStreamEvent,
} from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { verifiedWidgetContext as fixture } from "#lib/widget.fixture.js";
import {
  toRequest,
  type WidgetCase,
  widgetCaseSchema,
} from "#lib/widget-case.js";
import {
  answeredLane,
  gradeRun,
  replayAssessment,
  stepUsage,
  unrecordedReads,
} from "#lib/widget-graders.js";
import {
  claimsFor,
  JUDGE_OUTPUT,
  judgeAnswer,
  reviewedSample,
  saveRecord,
} from "#lib/widget-judge.js";
import { replayRecording } from "#lib/widget-replay.js";
import { readWidgetRun, type WidgetRun } from "#lib/widget-run-store.js";
import { SERVICE_SECRET_HEADER } from "#lib/widget-service-secret.js";

const POLL_MS = 3000;
const DEADLINE_MS = 300_000;
/** One review directory per eval invocation, shared by every case in it. */
const REVIEW_DIR = `${JUDGE_OUTPUT}/${new Date().toISOString().replace(/[:.]/g, "-")}`;

// WIDGET_REPLAY=1 enables the server; each request/session selects its own cassette.
export default readdirSync("evals/widget/cases")
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) =>
    defineEval({
      description: `Replay ${file} through the widget route with live models and recorded tool results.`,
      tags: ["widget"],
      async test(t) {
        if (
          process.env.WIDGET_REPLAY !== "1" &&
          !process.env.WIDGET_REPLAY_CASE
        ) {
          t.skip(
            "Enable WIDGET_REPLAY=1 on the eval target to replay widget cases."
          );
          return;
        }
        const path = `evals/widget/cases/${file}`;
        // The legacy single-case fallback replays only the case it names.
        const legacy = process.env.WIDGET_REPLAY_CASE;
        if (process.env.WIDGET_REPLAY !== "1" && legacy && legacy !== path) {
          t.skip(`WIDGET_REPLAY_CASE selects ${legacy}.`);
          return;
        }
        const recorded = widgetCaseSchema.parse(
          JSON.parse(readFileSync(path, "utf8"))
        );
        const scope = {
          conversation_id: randomUUID(),
          organization_id: fixture.organizationId,
        };
        const post = async (body: object) => {
          const response = await t.target.fetch("/internal/widget/message", {
            body: JSON.stringify({ ...scope, ...body }),
            headers: {
              // Any token: replay answers identity from the case's fixture scope.
              authorization: "Bearer replay",
              "content-type": "application/json",
              "x-widget-replay-case": file.slice(0, -5),
              [SERVICE_SECRET_HEADER]:
                process.env.FOREMAN_DIAGNOSTICS_SECRET ?? "",
            },
            method: "POST",
            signal: t.signal,
          });
          return (await response.json()) as Record<string, unknown>;
        };
        let result = await post({
          ...toRequest(recorded.question),
          ...(recorded.mode ? { mode: recorded.mode } : {}),
          message_id: randomUUID(),
          recording: replayRecording(recorded),
        });
        const runId = await t.require(
          result.run_id,
          satisfies((id) => typeof id === "string", "the route started a run")
        );
        const deadline = Date.now() + DEADLINE_MS;
        while (result.status === "pending" && Date.now() < deadline) {
          // biome-ignore lint/performance/noAwaitInLoops: each poll waits for the previous one.
          await sleep(POLL_MS, undefined, { signal: t.signal });
          result = await post({ action: "result", run_id: runId });
        }
        t.log(`outcome: ${JSON.stringify(result)}`);
        t.log(
          "The front door's help-center index and article fetch, if it ran, was a live read of the public docs."
        );
        await t.require(result.status, equals("completed"));
        t.check(
          result.message,
          result.decision === "block"
            ? equals(null)
            : satisfies(
                (message) => typeof message === "string" && message.length > 0,
                "the customer got an answer"
              )
        );
        await gradeReplay(
          t,
          await readWidgetRun(String(runId)),
          recorded,
          path
        );
      },
    })
  );

async function gradeReplay(
  t: EveEvalContext,
  run: WidgetRun,
  recorded: WidgetCase,
  path: string
) {
  const lane = answeredLane(run);
  const session =
    lane === "investigate" && run.session_id
      ? await t.target.attachSession(run.session_id, {
          startIndex: run.stream_index,
        })
      : null;
  const events = session?.events ?? [];
  const results = events
    .filter((event) => event.type === "action.result")
    .map(
      (event) => event.data.result as { output?: unknown; toolName?: string }
    );
  const tools = results.map((call) => call.toolName ?? "");
  const grades = gradeRun(
    {
      decision: run.outcome?.decision ?? "block",
      lane,
      message: run.outcome?.message ?? null,
      tools,
    },
    recorded
  );
  // Input matching is replayRead's job; an unrecorded read is an input no recording matched.
  const unrecorded = unrecordedReads(results, recorded);
  const { checks, outcome, scored } = replayAssessment(grades, unrecorded);

  // The row states coverage so partial measurements cannot look like full-run cost.
  t.log(
    `row: ${JSON.stringify({
      case: path,
      replayOutcome: outcome,
      scored,
      ...(scored
        ? grades
        : {
            leaks: grades.leaks,
            rawFields: grades.rawFields,
            unrecordedReads: unrecorded,
          }),
      // The gate's reason names the items a rewrite removed, e.g. jev:remove_items:2,3.
      gateReason: run.outcome?.reason ?? null,
      ...usageRow(events),
    })}`
  );
  if (session) {
    t.log(`tools: ${tools.join(", ")}`);
    for (const miss of results.filter((call) =>
      JSON.stringify(call).includes('"replay":"miss"')
    )) {
      t.log(`cassette miss: ${JSON.stringify(miss).slice(0, 300)}`);
    }
  }
  for (const [check, grade] of Object.entries(checks)) {
    if (grade !== "not set") {
      t.check(grade, equals("pass")).label(check);
    }
  }
  if (!scored) {
    const reason = `not scored: ${unrecorded.length} unrecorded reads: ${[...new Set(unrecorded)].join(", ")}`;
    t.log(reason);
    t.check(
      unrecorded,
      satisfies(() => false, reason)
    )
      .label("replay coverage")
      .soft();
    return;
  }
  await judgeClaims(t, run.outcome?.message ?? null, recorded, path);
  if (!session) {
    t.log("No investigation session: the front door answered.");
    return;
  }
  session.succeeded();
}

/**
 * One judge call per answered case. Verdicts are soft until Aaron's gold
 * labels show at least 90 percent agreement per claim (ENG-14686).
 */
async function judgeClaims(
  t: EveEvalContext,
  answer: string | null,
  recorded: WidgetCase,
  path: string
) {
  if (!answer) {
    return;
  }
  const claims = claimsFor(recorded);
  let verdicts: Awaited<ReturnType<typeof judgeAnswer>>;
  try {
    verdicts = await judgeAnswer(recorded, answer, claims, t.signal);
  } catch (error) {
    t.log(`judge failed: ${String(error).slice(0, 300)}`);
    t.check(
      null,
      satisfies(() => false, "the claims judge answered")
    ).soft();
    return;
  }
  const name = path.split("/").at(-1)?.slice(0, -5) ?? path;
  saveRecord(REVIEW_DIR, reviewedSample(name, recorded, answer, verdicts));
  t.log(`judge review: ${REVIEW_DIR}/review.md`);
  for (const verdict of verdicts) {
    t.log(`judge ${verdict.id}: ${verdict.verdict} (${verdict.reason})`);
    t.check(
      verdict.verdict,
      satisfies((value) => value === "yes", `judge: ${verdict.id}`)
    )
      .label(`judge ${verdict.id}`)
      .soft();
  }
}

function usageRow(events: readonly EveEvalStreamEvent[]) {
  const usage = stepUsage(events);
  const at = events.map((event) => Date.parse(event.meta.at));
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  return {
    cost: usage.priced
      ? `$${usage.costUsd.toFixed(4)} (${usage.priced}/${usage.steps} steps priced)`
      : "not available",
    investigation: at.length
      ? seconds(Math.max(...at) - Math.min(...at))
      : "not available",
    investigatorStepTime: usage.steps ? seconds(usage.stepMs) : "not available",
    steps: usage.steps,
    tokens: usage.usageReported
      ? `${usage.inputTokens} in / ${usage.outputTokens} out (${usage.usageReported}/${usage.steps} steps reported)`
      : "not available",
    usageCoverage:
      "Investigator session only; router, help-center, extractor, gate and composer calls are not counted.",
  };
}
