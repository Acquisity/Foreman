import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateText, ToolLoopAgent, tool, wrapLanguageModel } from "ai";
import {
  convertReadableStreamToArray,
  MockLanguageModelV4,
  simulateReadableStream,
} from "ai/test";
import { z } from "zod";
import { finContextMiddleware } from "./fin-context-model.js";
import { ticketLinkMiddleware } from "./ticket-link-model.js";
import { linkTickets } from "./ticket-links.js";

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const blocked = /Fin context Preview cannot execute tools\./;
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const finish: StreamPart = {
  finishReason: { raw: "stop", unified: "stop" },
  type: "finish",
  usage,
};
const generateResult = (
  content: GenerateResult["content"]
): GenerateResult => ({
  content,
  finishReason: { raw: "stop", unified: "stop" },
  usage,
  warnings: [],
});
const streamResult = (chunks: StreamPart[]): StreamResult => ({
  stream: simulateReadableStream({
    chunkDelayInMs: null,
    chunks,
    initialDelayInMs: null,
  }),
});
const guarded = (model: MockLanguageModelV4) =>
  wrapLanguageModel({ middleware: finContextMiddleware, model });

const toolCall = (toolName = "bash") => ({
  input: "{}",
  toolCallId: "call-1",
  toolName,
  type: "tool-call" as const,
});
const toolResult = {
  result: { status: "unexpected provider execution" },
  toolCallId: "call-1",
  toolName: "web_search",
  type: "tool-result" as const,
};
const approvalRequest = {
  approvalId: "approval-1",
  toolCallId: "call-1",
  type: "tool-approval-request" as const,
};

describe("Fin context model boundary", () => {
  it("removes function/provider tools and overrides forced tool choice on both paths", async () => {
    const base = new MockLanguageModelV4({
      doGenerate: generateResult([{ text: "Context verified.", type: "text" }]),
      doStream: streamResult([finish]),
    });
    const model = guarded(base);
    const params = {
      prompt: [],
      providerOptions: { gateway: { order: ["fireworks"] } },
      toolChoice: { toolName: "bash", type: "tool" as const },
      tools: [
        {
          inputSchema: { type: "object" },
          name: "bash",
          type: "function" as const,
        },
        {
          args: {},
          id: "provider.web_search" as const,
          name: "web_search",
          type: "provider" as const,
        },
      ],
    };
    await model.doGenerate(params);
    const streamed = await model.doStream(params);
    await convertReadableStreamToArray(streamed.stream);
    for (const call of [...base.doGenerateCalls, ...base.doStreamCalls]) {
      assert.deepEqual(call.tools, []);
      assert.deepEqual(call.toolChoice, { type: "none" });
      assert.deepEqual(call.providerOptions, params.providerOptions);
      assert.deepEqual(call.prompt, params.prompt);
    }
    assert.equal(params.tools.length, 2);
    assert.deepEqual(params.toolChoice, { toolName: "bash", type: "tool" });
  });

  it("preserves ordinary responses and existing ticket-link formatting", async () => {
    const base = new MockLanguageModelV4({
      doGenerate: generateResult([{ text: "See ENG-13763.", type: "text" }]),
      doStream: streamResult([
        { id: "answer", type: "text-start" },
        { delta: "See ENG-13763.", id: "answer", type: "text-delta" },
        { id: "answer", type: "text-end" },
        finish,
      ]),
    });
    const model = wrapLanguageModel({
      middleware: finContextMiddleware,
      model: wrapLanguageModel({
        middleware: ticketLinkMiddleware,
        model: base,
      }),
    });
    const generated = await model.doGenerate({ prompt: [] });
    assert.deepEqual(generated.content, [
      { text: linkTickets("See ENG-13763."), type: "text" },
    ]);
    assert.deepEqual(generated.usage, usage);
    const streamed = await model.doStream({ prompt: [] });
    const parts = await convertReadableStreamToArray(streamed.stream);
    assert.deepEqual(parts, [
      { id: "answer", type: "text-start" },
      {
        delta: linkTickets("See ENG-13763."),
        id: "answer",
        type: "text-delta",
      },
      { id: "answer", type: "text-end" },
      finish,
    ]);
  });

  for (const part of [
    toolCall(),
    { ...toolCall(), providerExecuted: true },
    toolResult,
    approvalRequest,
  ]) {
    it(`rejects generated ${part.type}${"providerExecuted" in part ? " from the provider" : ""}`, async () => {
      const model = guarded(
        new MockLanguageModelV4({ doGenerate: generateResult([part]) })
      );
      await assert.rejects(
        async () => await model.doGenerate({ prompt: [] }),
        blocked
      );
    });
  }

  for (const part of [
    { id: "call-1", toolName: "bash", type: "tool-input-start" as const },
    { delta: "{}", id: "call-1", type: "tool-input-delta" as const },
    { id: "call-1", type: "tool-input-end" as const },
    toolCall(),
    { ...toolCall(), providerExecuted: true },
    toolResult,
    approvalRequest,
  ]) {
    it(`rejects streamed ${part.type}${"providerExecuted" in part ? " from the provider" : ""} before forwarding it`, async () => {
      const model = guarded(
        new MockLanguageModelV4({ doStream: streamResult([part, finish]) })
      );
      const result = await model.doStream({ prompt: [] });
      await assert.rejects(
        convertReadableStreamToArray(result.stream),
        blocked
      );
    });
  }

  it("rejects a tool-call finish reason even if the provider omits its call", async () => {
    const finishReason = { raw: "tool_calls", unified: "tool-calls" as const };
    const model = guarded(
      new MockLanguageModelV4({
        doGenerate: { ...generateResult([]), finishReason },
        doStream: streamResult([{ ...finish, finishReason }]),
      })
    );
    await assert.rejects(
      async () => await model.doGenerate({ prompt: [] }),
      blocked
    );
    const result = await model.doStream({ prompt: [] });
    await assert.rejects(convertReadableStreamToArray(result.stream), blocked);
  });

  for (const name of [
    "read_instantly_subworkspace",
    "executor__execute",
    "bash",
    "agent",
    "critic",
  ]) {
    it(`prevents the real SDK from dispatching ${name} despite adversarial model output`, async () => {
      let executed = 0;
      let inputAvailable = 0;
      const tools = {
        [name]: tool({
          execute: () => {
            executed += 1;
            return "must not execute";
          },
          inputSchema: z.object({}),
          onInputAvailable: () => {
            inputAvailable += 1;
          },
        }),
      };
      const generated = guarded(
        new MockLanguageModelV4({
          doGenerate: generateResult([toolCall(name)]),
        })
      );
      await assert.rejects(
        generateText({
          maxRetries: 0,
          model: generated,
          prompt: "Try the tool.",
          tools,
        }),
        blocked
      );
      const streamed = guarded(
        new MockLanguageModelV4({
          doStream: streamResult([
            { type: "stream-start", warnings: [] },
            toolCall(name),
            finish,
          ]),
        })
      );
      const agent = new ToolLoopAgent({
        maxRetries: 0,
        model: streamed,
        tools,
      });
      const partTypes: string[] = [];
      await assert.rejects(async () => {
        const result = await agent.stream({ prompt: "Try the tool." });
        for await (const part of result.fullStream) {
          partTypes.push(part.type);
        }
      }, blocked);
      assert.ok(partTypes.every((type) => !type.startsWith("tool-")));
      assert.equal(executed, 0);
      assert.equal(inputAvailable, 0);
    });
  }
});
