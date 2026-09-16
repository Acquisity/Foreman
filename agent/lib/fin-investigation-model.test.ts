import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateText, tool, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { finInvestigationMiddleware } from "./fin-investigation-model.js";

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const BLOCKED = /Customer investigation capability is unavailable/;
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

describe("Fin customer investigation model boundary", () => {
  it("advertises scoped evidence and the bounded ticket write and removes a forced disallowed choice", async () => {
    const base = new MockLanguageModelV4({
      doGenerate: {
        content: [{ text: "Unavailable.", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage,
        warnings: [],
      },
    });
    const model = wrapLanguageModel({
      middleware: finInvestigationMiddleware,
      model: base,
    });
    await model.doGenerate({
      prompt: [],
      toolChoice: { toolName: "executor__execute", type: "tool" },
      tools: [
        { inputSchema: { type: "object" }, name: "agent", type: "function" },
        {
          inputSchema: { type: "object" },
          name: "read_fin_outreach_evidence",
          type: "function",
        },
        {
          inputSchema: { type: "object" },
          name: "file_fin_investigation_ticket",
          type: "function",
        },
        {
          inputSchema: { type: "object" },
          name: "task_cancel",
          type: "function",
        },
        {
          inputSchema: { type: "object" },
          name: "executor__execute",
          type: "function",
        },
        { inputSchema: { type: "object" }, name: "critic", type: "function" },
        { inputSchema: { type: "object" }, name: "vision", type: "function" },
        { inputSchema: { type: "object" }, name: "bash", type: "function" },
      ],
    });
    assert.deepEqual(
      base.doGenerateCalls[0]?.tools?.map((entry) => entry.name),
      ["read_fin_outreach_evidence", "file_fin_investigation_ticket"]
    );
    // The ticket tool is offered and this turn holds no result from it.
    assert.deepEqual(base.doGenerateCalls[0]?.toolChoice, { type: "required" });
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
    const model = wrapLanguageModel({
      middleware: finInvestigationMiddleware,
      model: base,
    });
    await model.doGenerate({
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
      toolChoice: { toolName: "executor__execute", type: "tool" },
      tools: [
        {
          inputSchema: { type: "object" },
          name: "file_fin_investigation_ticket",
          type: "function",
        },
      ],
    });
    assert.deepEqual(base.doGenerateCalls[0]?.toolChoice, { type: "auto" });
  });

  for (const name of [
    "agent",
    "task_cancel",
    "executor__execute",
    "planetscale_execute_read_query",
    "github__createPullRequest",
    "browser__navigate",
    "bash",
    "critic",
    "vision",
  ]) {
    it(`rejects an adversarial ${name} call before SDK dispatch`, async () => {
      let executed = 0;
      const model = wrapLanguageModel({
        middleware: finInvestigationMiddleware,
        model: new MockLanguageModelV4({ doGenerate: result(name) }),
      });
      await assert.rejects(
        generateText({
          maxRetries: 0,
          model,
          prompt: "Try it.",
          tools: {
            [name]: tool({
              execute: () => {
                executed += 1;
                return "must not execute";
              },
              inputSchema: z.object({}),
            }),
          },
        }),
        BLOCKED
      );
      assert.equal(executed, 0);
    });
  }

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
      const model = wrapLanguageModel({
        middleware: finInvestigationMiddleware,
        model: base,
      });
      await model.doGenerate({
        prompt: [
          {
            content: [{ text: reference, type: "text" }],
            role: "user",
          },
        ],
        toolChoice: { type: "auto" },
      });
      assert.deepEqual(base.doGenerateCalls[0]?.toolChoice, { type: "auto" });
    });
  }
});
