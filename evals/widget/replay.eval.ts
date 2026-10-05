import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import { verifiedWidgetContext as fixture } from "#lib/widget.fixture.js";
import { widgetCaseSchema } from "#lib/widget-case.js";
import { REPLAY_TICKET, replayRecording } from "#lib/widget-replay.js";
import { readWidgetRun } from "#lib/widget-run-store.js";
import { SERVICE_SECRET_HEADER } from "#lib/widget-service-secret.js";

const LATEST = "LATEST CUSTOMER MESSAGE (the one to work on):\n";
const EARLIER = "\n\nEARLIER TURNS (";
const TURN = /^(Customer|Support): /u;
const POLL_MS = 3000;
const DEADLINE_MS = 300_000;

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

export default defineEval({
  description:
    "Replays the case WIDGET_REPLAY_CASE names through the widget message route with live models and recorded tool results.",
  async test(t) {
    const path = process.env.WIDGET_REPLAY_CASE;
    if (!path) {
      t.skip("Set WIDGET_REPLAY_CASE to a case under evals/widget/cases/.");
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
          [SERVICE_SECRET_HEADER]: process.env.FOREMAN_DIAGNOSTICS_SECRET ?? "",
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
    t.check(
      result.message,
      satisfies(
        (message) => typeof message === "string" && message.length > 0,
        "the customer got an answer"
      )
    );
    const run = await readWidgetRun(String(runId));
    if (!run.session_id) {
      t.log("No investigation session: the front door answered.");
      return;
    }
    const session = await t.target.attachSession(run.session_id, {
      startIndex: run.stream_index,
    });
    session.succeeded();
    const results = session.events.filter(
      (event) => event.type === "action.result"
    );
    t.log(
      `tools: ${results.map((event) => (event.data.result as { toolName?: string }).toolName).join(", ")}`
    );
    const misses = results.filter((event) =>
      JSON.stringify(event.data).includes('"replay":"miss"')
    );
    for (const miss of misses) {
      t.log(`cassette miss: ${JSON.stringify(miss.data).slice(0, 300)}`);
    }
    // Every result is that tool's recorded output verbatim, so no provider answered any call.
    // Input matching is replayRead's job; a miss above is an unmatched input.
    const recordedOutputs = new Set([
      ...recorded.cassette.map((entry) =>
        JSON.stringify([entry.tool, entry.output])
      ),
      JSON.stringify(["widget_file_ticket", REPLAY_TICKET]),
    ]);
    const live = results.filter((event) => {
      const call = event.data.result as {
        output?: unknown;
        toolName?: string;
      };
      return !recordedOutputs.has(JSON.stringify([call.toolName, call.output]));
    });
    t.log(
      `tool results: ${results.length}, cassette misses: ${misses.length}, not from the cassette: ${live.length}`
    );
    t.check(misses.length, equals(0));
    t.check(live.length, equals(0));
  },
});
