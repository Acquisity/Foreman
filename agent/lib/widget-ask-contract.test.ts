import assert from "node:assert/strict";
import { test } from "node:test";
import { simulateStreamingMiddleware, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { gate } from "./widget-egress.js";
import {
  finishWidgetRun,
  waitForWidgetInvestigation,
  widgetRunResponse,
} from "./widget-investigation.js";
import { widgetInvestigationMiddleware } from "./widget-investigation-model.js";
import { widgetNextActionMiddleware } from "./widget-next-action.js";
import type { WidgetRun } from "./widget-run-store.js";

/**
 * Run 07133479 on 727b114: the deployed ask tool returned the payload below, the
 * selector logged question_recorded, the finish parser refused it for ending in
 * a period, "asked" was extracted as findings and the thread went to a person.
 * Every stage here runs on what the stage before it really produced, starting
 * from the tool's own execute.
 */
const LIVE =
  "Which campaign is this about? Sharing its name will let me look at the right one.";
const widgetCtx = {
  session: {
    auth: { initiator: { attributes: {}, issuer: "foreman:widget-support" } },
  },
};
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const ASK = {
  description: "Record the question",
  inputSchema: { type: "object" as const },
  name: "widget_ask_customer",
  type: "function" as const,
};
const READ = { ...ASK, name: "widget_outreach_health" };

async function execute(question: string): Promise<unknown> {
  process.env.WIDGET_NEXT_ACTION = "jev";
  const dynamic = (await import("../tools/widget_ask_customer.js")).default;
  const tool = dynamic.events["step.started"]?.(
    {} as never,
    widgetCtx as never
  ) as unknown as {
    execute: (input: { question: string }, ctx: unknown) => unknown;
  };
  return tool.execute({ question }, widgetCtx);
}

/** The selector's next step after these ask results, and what it sends the model. */
async function nextStep(outputs: unknown[]) {
  let jevCalls = 0;
  const base = new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve({
        content: [{ text: "asked", type: "text" as const }],
        finishReason: { raw: "stop", unified: "stop" as const },
        usage,
        warnings: [],
      }),
  });
  const model = wrapLanguageModel({
    middleware: [
      widgetInvestigationMiddleware(),
      simulateStreamingMiddleware(),
      widgetNextActionMiddleware({
        apiKey: "k",
        fetch: () => {
          jevCalls += 1;
          return Promise.reject(new Error("unused"));
        },
      }),
    ],
    model: base,
  });
  const step = (name: string, id: string, output: unknown) => [
    {
      content: [
        {
          input: {},
          toolCallId: id,
          toolName: name,
          type: "tool-call" as const,
        },
      ],
      role: "assistant" as const,
    },
    {
      content: [
        {
          output: { type: "json" as const, value: output as never },
          toolCallId: id,
          toolName: name,
          type: "tool-result" as const,
        },
      ],
      role: "tool" as const,
    },
  ];
  await model.doGenerate({
    prompt: [
      {
        content: [{ text: "Why did my campaign stop?", type: "text" }],
        role: "user",
      },
      ...step(READ.name, "r", { campaigns: ["A", "B"] }),
      ...outputs.flatMap((output, n) => step(ASK.name, `a${n}`, output)),
    ],
    tools: [READ, ASK],
  });
  const [sent] = base.doGenerateCalls;
  return {
    jevCalls,
    note: JSON.stringify(sent.prompt.at(-1)),
    toolChoice: sent.toolChoice,
    tools: (sent.tools ?? []).map((tool) => tool.name),
  };
}

async function deliver(output: unknown, closing: string) {
  const events = [
    { data: {}, type: "turn.started" },
    {
      data: {
        result: {
          callId: "c",
          kind: "tool-result",
          output,
          toolName: "widget_ask_customer",
        },
      },
      type: "action.result",
    },
    { data: { message: closing }, type: "message.completed" },
    { data: {}, type: "session.completed" },
  ];
  const outcome = await waitForWidgetInvestigation({
    getEventStream: () =>
      Promise.resolve(
        new ReadableStream({
          start(controller) {
            for (const item of events) {
              controller.enqueue(item);
            }
            controller.close();
          },
        })
      ),
  } as never);
  const run: WidgetRun = {
    completed_at: null,
    created_at: new Date(),
    decision: null,
    findings: null,
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    outcome: null,
    question: "Why did my campaign stop?",
    scope,
    session_id: "s",
    stream_index: 0,
  };
  let extracted = 0;
  const finished = await finishWidgetRun(run, "s", outcome, {
    claimFinish: () => Promise.resolve(true),
    complete: (_id, result, stored) => {
      run.outcome = result;
      run.findings = stored;
      return Promise.resolve(run);
    },
    extract: () => {
      extracted += 1;
      return Promise.resolve(null);
    },
    gate: (gateScope, question, findings, deps, conversation) =>
      gate(
        gateScope,
        question,
        findings,
        {
          compose:
            deps?.compose ?? (() => assert.fail("a question is not composed")),
          judge: () => Promise.resolve({ decision: "allow", reason: "ok" }),
          resolve: () =>
            Promise.resolve({
              domains: new Set<string>(),
              emails: new Set<string>(),
              slugs: new Set<string>(),
              uuids: new Set<string>(),
            }),
        },
        conversation
      ),
    history: () => Promise.resolve([]),
  });
  assert.ok(finished);
  return { extracted, response: widgetRunResponse(finished) };
}

test("the exact live ask payload is recorded by the tool, ends the turn, and reaches the customer with no extraction or composing", async () => {
  const output = await execute(LIVE);
  assert.deepEqual(output, { asked: LIVE });

  const step = await nextStep([output]);
  assert.deepEqual(step.tools, []);
  assert.equal(step.jevCalls, 0);

  const { extracted, response } = await deliver(output, "asked");
  assert.equal(extracted, 0);
  assert.ok("message" in response);
  assert.equal(response.message, LIVE);
  assert.equal(response.decision, "allow");
});

test("a question the tool does not record comes back as an error, is retried once, and is never finished as asked", async () => {
  const rejected = await execute("Tell me the campaign name.");
  assert.equal("error" in (rejected as object), true);

  // First failure: the ask tool is forced again, not an empty last step.
  const retry = await nextStep([rejected]);
  assert.deepEqual(retry.tools, ["widget_ask_customer"]);
  assert.deepEqual(retry.toolChoice, {
    type: "required",
  });

  // Second failure: the ordinary write-up, with its note, and no "asked" step.
  const gaveUp = await nextStep([rejected, rejected]);
  assert.equal(gaveUp.tools.includes("widget_ask_customer"), false);
  assert.equal(gaveUp.toolChoice, undefined);
  assert.equal(gaveUp.note.includes("Write your findings now"), true);

  // The finish reads the same contract: an error result is not a question, so the
  // write-up is structured the ordinary way instead of "asked" being delivered.
  const { extracted } = await deliver(
    rejected,
    "Several campaigns are paused."
  );
  assert.equal(extracted, 1);
});

test("an errored tool call is not a recorded question either", async () => {
  const outcome = await waitForWidgetInvestigation({
    getEventStream: () =>
      Promise.resolve(
        new ReadableStream({
          start(controller) {
            controller.enqueue({
              data: {
                result: {
                  isError: true,
                  kind: "tool-result",
                  output: { asked: LIVE },
                  toolName: "widget_ask_customer",
                },
              },
              type: "action.result",
            });
            controller.enqueue({ data: {}, type: "session.completed" });
            controller.close();
          },
        })
      ),
  } as never);
  assert.equal(outcome.status === "completed" && outcome.asked, undefined);
});
