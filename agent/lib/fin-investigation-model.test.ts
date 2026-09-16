import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateText, stepCountIs, tool, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { finInvestigationMiddleware } from "./fin-investigation-model.js";

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const toolCall = (toolName: string) => ({
  input: "{}",
  toolCallId: "call-1",
  toolName,
  type: "tool-call" as const,
});
const result = (toolName: string) => ({
  content: [toolCall(toolName)],
  finishReason: { raw: "tool_calls", unified: "tool-calls" as const },
  usage,
  warnings: [],
});
const wrapped = (base: MockLanguageModelV4) =>
  wrapLanguageModel({ middleware: finInvestigationMiddleware, model: base });
const ticketTool = {
  inputSchema: { type: "object" as const },
  name: "file_fin_investigation_ticket",
  type: "function" as const,
};

describe("Fin customer investigation ticket decision", () => {
  it("forces the decision while the tool is offered and the turn holds no result", async () => {
    const base = new MockLanguageModelV4({
      doGenerate: {
        content: [{ text: "Checking.", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage,
        warnings: [],
      },
    });
    await wrapped(base).doGenerate({
      prompt: [],
      toolChoice: { type: "auto" },
      tools: [
        {
          inputSchema: { type: "object" },
          name: "fin_provider",
          type: "function",
        },
        ticketTool,
      ],
    });
    assert.deepEqual(base.doGenerateCalls[0]?.toolChoice, { type: "required" });
    // The lane's tools are composed, not filtered here.
    assert.deepEqual(
      base.doGenerateCalls[0]?.tools?.map((entry) => entry.name),
      ["fin_provider", "file_fin_investigation_ticket"]
    );
  });

  it("stops forcing the ticket decision once the turn carries its result", async () => {
    const base = new MockLanguageModelV4({
      doGenerate: {
        content: [{ text: "Filed.", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage,
        warnings: [],
      },
    });
    await wrapped(base).doGenerate({
      prompt: [
        {
          content: [
            {
              output: { type: "json", value: { outcome: "not-needed" } },
              toolCallId: "call-1",
              toolName: "file_fin_investigation_ticket",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ],
      toolChoice: { type: "auto" },
      tools: [ticketTool],
    });
    assert.deepEqual(base.doGenerateCalls[0]?.toolChoice, { type: "auto" });
  });

  it("reaches a final answer even when the model only calls read tools", async () => {
    let step = 0;
    const model = wrapLanguageModel({
      middleware: finInvestigationMiddleware,
      model: new MockLanguageModelV4({
        doGenerate: (options) => {
          step += 1;
          if (options.toolChoice?.type === "auto") {
            return Promise.resolve({
              content: [
                { text: "Here is what I found.", type: "text" as const },
              ],
              finishReason: { raw: "stop", unified: "stop" as const },
              usage,
              warnings: [],
            });
          }
          // A model that never volunteers the decision: it only ever reads.
          const forced = options.toolChoice?.type === "tool";
          return Promise.resolve({
            content: [
              {
                input: forced
                  ? '{"action":"not-needed","reason":"No fault found."}'
                  : "{}",
                toolCallId: `call-${step}`,
                toolName: forced
                  ? "file_fin_investigation_ticket"
                  : "fin_provider",
                type: "tool-call" as const,
              },
            ],
            finishReason: { raw: "tool_calls", unified: "tool-calls" as const },
            usage,
            warnings: [],
          });
        },
      }),
    });
    const answer = await generateText({
      maxRetries: 0,
      model,
      prompt: "Why did my campaign stop?",
      stopWhen: stepCountIs(30),
      tools: {
        file_fin_investigation_ticket: tool({
          execute: () => ({
            message: "No fault found.",
            outcome: "not-needed",
          }),
          inputSchema: z.object({ action: z.string(), reason: z.string() }),
        }),
        fin_provider: tool({
          execute: () => ({ rows: [] }),
          inputSchema: z.object({}),
        }),
      },
    });
    assert.equal(answer.text, "Here is what I found.");
    assert.ok(
      answer.steps.length < 30,
      "the forced tool choice must be dischargeable"
    );
  });

  for (const reference of [
    "Please file an engineering ticket for this report.",
    "Please do not file another ticket for this issue.",
    "Was a ticket opened for this report?",
    "A ticket was created for this report.",
    "When I open the campaign, the issue is that leads do not log in.",
  ]) {
    it(`does not force a ticket write from customer text: ${reference}`, async () => {
      const base = new MockLanguageModelV4({
        doGenerate: result("file_fin_investigation_ticket"),
      });
      await wrapped(base).doGenerate({
        prompt: [
          { content: [{ text: reference, type: "text" }], role: "user" },
        ],
        toolChoice: { type: "auto" },
      });
      assert.deepEqual(base.doGenerateCalls[0]?.toolChoice, { type: "auto" });
    });
  }
});
