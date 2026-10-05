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
import { type WidgetCase, widgetCaseSchema } from "#lib/widget-case.js";
import { answeredLane, gradeRun, stepUsage } from "#lib/widget-graders.js";
import {
  claimsFor,
  JUDGE_MODEL,
  JUDGE_OUTPUT,
  judgeAnswer,
  saveRecord,
} from "#lib/widget-judge.js";
import { REPLAY_TICKET, replayRecording } from "#lib/widget-replay.js";
import { readWidgetRun, type WidgetRun } from "#lib/widget-run-store.js";
import { SERVICE_SECRET_HEADER } from "#lib/widget-service-secret.js";

const LATEST = "LATEST CUSTOMER MESSAGE (the one to work on):\n";
const EARLIER = "\n\nEARLIER TURNS (";
const TURN = /^(Customer|Support): /u;
const POLL_MS = 3000;
const DEADLINE_MS = 300_000;
/** One review directory per eval invocation, shared by every case in it. */
const REVIEW_DIR = `${JUDGE_OUTPUT}/${new Date().toISOString().replace(/[:.]/g, "-")}`;

/** A recorded question is the router's rendering; split it back into the message and its earlier turns. */
function toRequest(question: string) {
  if (!question.startsWith(LATEST)) {
    return { question };
  }
  const cut = question.indexOf(EARLIER);
  const latest = question.slice(LATEST.length, cut < 0 ? undefined : cut);
  const history: { role: "assistant" | "customer"; text: string }[] = [];
  const lines =
    cut < 0
      ? []
      : question.slice(question.indexOf("\n", cut + 2) + 1).split("\n");
  for (const line of lines) {
    const role = TURN.exec(line)?.[1];
    if (role) {
      history.push({
        role: role === "Customer" ? "customer" : "assistant",
        text: line.slice(role.length + 2),
      });
    } else {
      const last = history.at(-1);
      if (last) {
        last.text += `\n${line}`;
      }
    }
  }
  return { history, question: latest };
}

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
  const tools = events
    .filter((event) => event.type === "action.result")
    .map(
      (event) => (event.data.result as { toolName?: string }).toolName ?? ""
    );
  const grades = gradeRun(
    {
      decision: run.outcome?.decision ?? "block",
      lane,
      message: run.outcome?.message ?? null,
      tools,
    },
    recorded
  );

  // The row states coverage so partial measurements cannot look like full-run cost.
  t.log(
    `row: ${JSON.stringify({
      case: path,
      ...grades,
      // The gate's reason names the items a rewrite removed, e.g. jev:remove_items:2,3.
      gateReason: run.outcome?.reason ?? null,
      ...usageRow(events),
    })}`
  );
  for (const [check, grade] of Object.entries(grades)) {
    if (grade !== "not set") {
      t.check(grade, equals("pass")).label(check);
    }
  }
  await judgeClaims(t, run.outcome?.message ?? null, recorded, path);
  if (!session) {
    t.log("No investigation session: the front door answered.");
    return;
  }
  session.succeeded();
  const results = events.filter((event) => event.type === "action.result");
  t.log(
    `tools: ${results.map((event) => (event.data.result as { toolName?: string }).toolName).join(", ")}`
  );
  const misses = results.filter((event) =>
    JSON.stringify(event.data).includes('"replay":"miss"')
  );
  for (const miss of misses) {
    t.log(`cassette miss: ${JSON.stringify(miss.data).slice(0, 300)}`);
  }
  // Read-free control results are newly authored, not provider reads.
  const recordedOutputs = new Set([
    ...recorded.cassette.map((entry) => JSON.stringify(entry.output)),
    JSON.stringify(REPLAY_TICKET),
  ]);
  const live = results.filter(
    (event) =>
      (event.data.result as { toolName?: string }).toolName !==
        "widget_ask_customer" &&
      !recordedOutputs.has(
        JSON.stringify((event.data.result as { output?: unknown }).output)
      )
  );
  t.log(
    `tool results: ${results.length}, cassette misses: ${misses.length}, not from the cassette: ${live.length}`
  );
  t.check(misses.length, equals(0));
  t.check(live.length, equals(0));
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
  try {
    const verdicts = await judgeAnswer(recorded, answer, claims, t.signal);
    const name = path.split("/").at(-1)?.slice(0, -5) ?? path;
    saveRecord(REVIEW_DIR, {
      answer,
      case: name,
      judgedAt: new Date().toISOString(),
      model: JUDGE_MODEL,
      verdicts: verdicts.map((verdict, n) => ({
        ...verdict,
        claim: claims[n]?.text ?? "",
      })),
    });
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
  } catch (error) {
    t.log(`judge failed: ${String(error).slice(0, 300)}`);
    t.check(
      null,
      satisfies(() => false, "the claims judge answered")
    ).soft();
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
    total: at.length
      ? seconds(Math.max(...at) - Math.min(...at))
      : "not available",
    usageCoverage:
      "Investigator session only; router, help-center, extractor, gate and composer calls are not counted.",
  };
}
