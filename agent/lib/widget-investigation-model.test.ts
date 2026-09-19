import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateText, tool, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { widgetInvestigationMiddleware } from "./widget-investigation-model.js";

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const BLOCKED = /Support investigation capability is unavailable/;
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

describe("widget support investigation model boundary", () => {
  it("advertises only the evidence tools and the ticket tool, and drops a forced disallowed choice", async () => {
    const base = new MockLanguageModelV4({
      doGenerate: {
        content: [{ text: "ok", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage,
        warnings: [],
      },
    });
    const model = wrapLanguageModel({
      middleware: widgetInvestigationMiddleware(),
      model: base,
    });
    await model.doGenerate({
      prompt: [],
      toolChoice: { toolName: "web_fetch", type: "tool" },
      tools: [
        {
          inputSchema: { type: "object" },
          name: "widget_outreach_health",
          type: "function",
        },
        {
          inputSchema: { type: "object" },
          name: "widget_billing_summary",
          type: "function",
        },
        {
          inputSchema: { type: "object" },
          name: "widget_file_ticket",
          type: "function",
        },
        {
          inputSchema: { type: "object" },
          name: "web_fetch",
          type: "function",
        },
        {
          inputSchema: { type: "object" },
          name: "browser__read",
          type: "function",
        },
        { inputSchema: { type: "object" }, name: "sign_in", type: "function" },
      ],
    });
    assert.deepEqual(
      base.doGenerateCalls[0]?.tools?.map((entry) => entry.name),
      ["widget_outreach_health", "widget_billing_summary", "widget_file_ticket"]
    );
    assert.equal(base.doGenerateCalls[0]?.toolChoice, undefined);
  });

  for (const name of [
    "web_fetch",
    "browser__read",
    "browser__navigate",
    "bash",
    "sign_in",
    "file_fin_investigation_ticket",
    "executor__execute",
    "search_investigation_memory",
  ]) {
    it(`rejects an adversarial ${name} call before SDK dispatch`, async () => {
      let executed = 0;
      const model = wrapLanguageModel({
        middleware: widgetInvestigationMiddleware(),
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

  it("stops advertising tools once the tool-call budget is spent", async () => {
    const middleware = widgetInvestigationMiddleware();
    const doGenerate = () => Promise.resolve(result("widget_outreach_health"));
    for (let i = 0; i < 14; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential budget accrual.
      await middleware.wrapGenerate?.({ doGenerate } as never);
    }
    const transformed = await middleware.transformParams?.({
      params: {
        toolChoice: { type: "auto" },
        tools: [
          {
            inputSchema: { type: "object" },
            name: "widget_outreach_health",
            type: "function",
          },
        ],
      },
      type: "generate",
    } as never);
    assert.deepEqual((transformed as { tools?: unknown[] }).tools, []);
  });
});
