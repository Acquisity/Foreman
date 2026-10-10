import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import {
  generateText,
  simulateStreamingMiddleware,
  tool,
  wrapLanguageModel,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { composePrompt } from "./prompts.js";
import { sessionLane } from "./session-lane.js";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { widgetInvestigationMiddleware } from "./widget-investigation-model.js";
import { widgetNextActionMiddleware } from "./widget-next-action.js";
import { PRODUCT_GUIDE } from "./widget-product-guide.js";
import { widgetAuth } from "./widget-scope.js";

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const BLOCKED = /Support investigation capability is unavailable/;
const TIMED = /^start=\d+ ms=\d+$/;
// The mocked clock fixes the start; the duration depends on SDK clock reads.
const TIMED_FROM_MOCK = /^start=1025 ms=[1-9]\d*$/;
const toolCall = (toolName: string) => ({
  input: "{}",
  toolCallId: "call-1",
  toolName,
  type: "tool-call" as const,
});
const text = (value: string) => ({
  content: [{ text: value, type: "text" as const }],
  finishReason: { raw: "stop", unified: "stop" as const },
  usage,
  warnings: [],
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

  it("keeps the tools listed and unforced at every point of this turn's budget, counted across steps", async () => {
    const call = { toolName: "widget_sdr_thread_status", type: "tool-call" };
    const calls = (count: number) => ({
      content: Array.from({ length: count }, () => call),
      role: "assistant",
    });
    // Eve builds a new middleware for every step, so nothing may live in memory.
    const advertised = async (prompt: unknown[]) => {
      const transformed =
        await widgetInvestigationMiddleware().transformParams?.({
          params: {
            prompt,
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
      const { toolChoice, tools } = transformed as {
        toolChoice?: { type: string };
        tools?: unknown[];
      };
      assert.equal(tools?.length, 1);
      return toolChoice?.type;
    };
    const user = { content: [], role: "user" };
    assert.equal(await advertised([user, calls(7), calls(7)]), "auto");
    assert.equal(await advertised([user, calls(11)]), "auto");
    // Past the budget, or a workspace read in the last two calls, is refused
    // when generated (see "reserves the final two calls").
    assert.equal(await advertised([user, calls(12)]), "auto");
    // An earlier turn's calls do not starve the follow-up.
    assert.equal(await advertised([user, calls(14), user, calls(2)]), "auto");
  });

  it("drops the calls of a parallel batch that would pass the budget, before the SDK runs them", async () => {
    const batch = Array.from({ length: 4 }, (_, n) => ({
      ...toolCall("widget_outreach_health"),
      toolCallId: `call-${n}`,
    }));
    const generated = await widgetInvestigationMiddleware().wrapGenerate?.({
      doGenerate: () => Promise.resolve({ ...result("x"), content: batch }),
      params: {
        prompt: [
          { content: [], role: "user" },
          {
            content: Array.from({ length: 10 }, () => batch[0]),
            role: "assistant",
          },
        ],
      },
    } as never);
    // Two workspace calls remain; the last two slots are for articles.
    assert.deepEqual(
      generated?.content.map((part) => "toolCallId" in part && part.toolCallId),
      ["call-0", "call-1"]
    );
  });
});

for (const mode of ["generate", "stream"] as const) {
  it(`${mode}: reserves the final two calls for article search and reading`, async (t) => {
    const lines: string[] = [];
    t.mock.method(console, "info", (line: string) => lines.push(line));
    const names = [
      "widget_outreach_health",
      "widget_help_article",
      "widget_read_help_article",
      "widget_help_article",
    ];
    const base = new MockLanguageModelV4({
      doGenerate: {
        ...result("x"),
        content: names.map((name, n) => ({
          ...toolCall(name),
          toolCallId: `c${n}`,
        })),
      },
    });
    const model = wrapLanguageModel({
      middleware: [
        widgetInvestigationMiddleware(),
        simulateStreamingMiddleware(),
      ],
      model: base,
    });
    const params = {
      prompt: [
        {
          content: [{ text: "Check this", type: "text" as const }],
          role: "user" as const,
        },
        {
          content: Array.from({ length: 12 }, (_, n) => ({
            ...toolCall("widget_outreach_health"),
            input: {},
            toolCallId: `old${n}`,
          })),
          role: "assistant" as const,
        },
      ],
      toolChoice: { toolName: "widget_outreach_health", type: "tool" as const },
      tools: names.slice(0, 3).map((name) => ({
        inputSchema: { type: "object" },
        name,
        type: "function" as const,
      })),
    };
    const received: string[] = [];
    if (mode === "generate") {
      const output = await model.doGenerate(params);
      for (const part of output.content) {
        if (part.type === "tool-call") {
          received.push(part.toolName);
        }
      }
    } else {
      const { stream } = await model.doStream(params);
      for await (const part of stream) {
        if (part.type === "tool-call") {
          received.push(part.toolName);
        }
      }
    }
    assert.deepEqual(received, [
      "widget_help_article",
      "widget_read_help_article",
    ]);
    // The tools stay listed; the budget refuses the workspace read instead.
    assert.deepEqual(
      base.doGenerateCalls[0].tools?.map((entry) => entry.name),
      names.slice(0, 3)
    );
    assert.equal(base.doGenerateCalls[0].toolChoice, undefined);
    const logged = lines.map((line) => JSON.parse(line));
    assert.equal(logged.length, 1);
    assert.equal(logged[0].tool, received.join(","));
  });
}

for (const mode of ["generate", "stream"] as const) {
  it(`${mode}: keeps the ticket tool after the workspace reads run out, until the budget is spent`, async () => {
    const names = ["widget_outreach_health", "widget_file_ticket"];
    const base = new MockLanguageModelV4({
      doGenerate: {
        ...result("x"),
        content: names.map((name, n) => ({
          ...toolCall(name),
          toolCallId: `c${n}`,
        })),
      },
    });
    const model = wrapLanguageModel({
      middleware: [
        widgetInvestigationMiddleware(),
        simulateStreamingMiddleware(),
      ],
      model: base,
    });
    const params = (used: number) => ({
      prompt: [
        {
          content: [{ text: "Refund my last charge", type: "text" as const }],
          role: "user" as const,
        },
        {
          content: Array.from({ length: used }, (_, n) => ({
            ...toolCall("widget_billing_summary"),
            input: {},
            toolCallId: `old${n}`,
          })),
          role: "assistant" as const,
        },
      ],
      tools: names.map((name) => ({
        inputSchema: { type: "object" },
        name,
        type: "function" as const,
      })),
    });
    const received: string[] = [];
    if (mode === "generate") {
      const output = await model.doGenerate(params(12));
      for (const part of output.content) {
        if (part.type === "tool-call") {
          received.push(part.toolName);
        }
      }
    } else {
      const { stream } = await model.doStream(params(12));
      for await (const part of stream) {
        if (part.type === "tool-call") {
          received.push(part.toolName);
        }
      }
    }
    assert.deepEqual(received, ["widget_file_ticket"]);
    assert.deepEqual(
      base.doGenerateCalls[0].tools?.map((entry) => entry.name),
      names
    );
    const spent = (await widgetInvestigationMiddleware().transformParams?.({
      params: params(14),
      type: "generate",
    } as never)) as { toolChoice?: unknown; tools?: { name: string }[] };
    assert.deepEqual(
      spent.tools?.map((entry) => entry.name),
      names
    );
    assert.equal(spent.toolChoice, undefined);
  });
}

for (const mode of ["generate", "stream"] as const) {
  it(`${mode}: logs one timed line per model call naming the tools it kept`, async (t) => {
    const lines: string[] = [];
    t.mock.method(console, "info", (line: string) => lines.push(line));
    let now = 1000;
    t.mock.method(Date, "now", () => {
      now += 25;
      return now;
    });
    const base = new MockLanguageModelV4({
      doGenerate: result("widget_inbox_health"),
    });
    const model = wrapLanguageModel({
      middleware: [
        widgetInvestigationMiddleware("wrun_test"),
        simulateStreamingMiddleware(),
      ],
      model: base,
    });
    const params = {
      prompt: [
        {
          content: [{ text: "Hi", type: "text" as const }],
          role: "user" as const,
        },
      ],
    };
    if (mode === "generate") {
      await model.doGenerate(params);
    } else {
      const { stream } = await model.doStream(params);
      for await (const _ of stream) {
        // drain
      }
    }
    const logged = lines
      .map((line) => JSON.parse(line))
      .filter((line) => line.event === "widget.investigation.model_call");
    assert.equal(logged.length, 1);
    assert.equal(logged[0].sessionId, "wrun_test");
    assert.equal(logged[0].tool, "widget_inbox_health");
    assert.match(logged[0].message, TIMED_FROM_MOCK);
  });
}

for (const mode of ["generate", "stream"] as const) {
  for (const failure of ["provider", "boundary"] as const) {
    it(`${mode}: times a ${failure} failure without logging its contents`, async (t) => {
      const lines: string[] = [];
      t.mock.method(console, "info", (line: string) => lines.push(line));
      const providerError = new Error("private provider failure");
      const model = wrapLanguageModel({
        middleware: [
          widgetInvestigationMiddleware("wrun_failed"),
          simulateStreamingMiddleware(),
        ],
        model: new MockLanguageModelV4({
          doGenerate:
            failure === "provider"
              ? () => Promise.reject(providerError)
              : result("private_forbidden_tool"),
        }),
      });
      await assert.rejects(
        async () => {
          if (mode === "generate") {
            await model.doGenerate({ prompt: [] });
          } else {
            const { stream } = await model.doStream({ prompt: [] });
            for await (const _ of stream) {
              // drain
            }
          }
        },
        failure === "provider" ? providerError : BLOCKED
      );
      const logged = lines.map((line) => JSON.parse(line));
      assert.equal(logged.length, 1);
      assert.equal(logged[0].event, "widget.investigation.model_call");
      assert.equal(logged[0].sessionId, "wrun_failed");
      assert.equal(logged[0].tool, null);
      assert.match(logged[0].message, TIMED);
      assert.equal(lines.join("").includes("private"), false);
    });
  }
}

for (const end of ["error", "cancel", "close"] as const) {
  it(`stream: times ${end} without a finish part exactly once`, async (t) => {
    const lines: string[] = [];
    t.mock.method(console, "info", (line: string) => lines.push(line));
    const providerError = new Error("private stream failure");
    let cancelled = false;
    const model = wrapLanguageModel({
      middleware: widgetInvestigationMiddleware("wrun_stream"),
      model: new MockLanguageModelV4({
        doStream: {
          stream: new ReadableStream({
            cancel() {
              cancelled = true;
            },
            start(controller) {
              if (end === "error") {
                controller.error(providerError);
              } else if (end === "close") {
                controller.close();
              }
            },
          }),
        },
      }),
    });
    const { stream } = await model.doStream({ prompt: [] });
    const reader = stream.getReader();
    if (end === "cancel") {
      await reader.cancel();
      assert.equal(cancelled, true);
    } else if (end === "error") {
      await assert.rejects(reader.read(), providerError);
    } else {
      assert.equal((await reader.read()).done, true);
    }
    const logged = lines.map((line) => JSON.parse(line));
    assert.equal(logged.length, 1);
    assert.equal(logged[0].event, "widget.investigation.model_call");
    assert.equal(logged[0].tool, null);
    assert.match(logged[0].message, TIMED);
    assert.equal(lines.join("").includes("private"), false);
  });
}

for (const mode of ["generate", "stream"] as const) {
  it(`${mode}: past the budget a call is refused and the step asked once more with no tool`, async () => {
    const replies = [result("widget_file_ticket"), text("findings")];
    const base = new MockLanguageModelV4({
      doGenerate: () => Promise.resolve(replies.shift() ?? text("findings")),
    });
    const model = wrapLanguageModel({
      middleware: [
        widgetInvestigationMiddleware(),
        simulateStreamingMiddleware(),
      ],
      model: base,
    });
    const params = {
      prompt: [
        {
          content: [{ text: "Refund my last charge", type: "text" as const }],
          role: "user" as const,
        },
        {
          content: Array.from({ length: 14 }, (_, n) => ({
            ...toolCall("widget_billing_summary"),
            input: {},
            toolCallId: `old${n}`,
          })),
          role: "assistant" as const,
        },
      ],
      tools: [
        {
          inputSchema: { type: "object" },
          name: "widget_file_ticket",
          type: "function" as const,
        },
      ],
    };
    const types: string[] = [];
    if (mode === "generate") {
      const output = await model.doGenerate(params);
      types.push(...output.content.map((part) => part.type));
    } else {
      const { stream } = await model.doStream(params);
      for await (const part of stream) {
        types.push(part.type);
      }
    }
    assert.equal(types.includes("tool-call"), false);
    assert.equal(types.includes("text-delta") || types.includes("text"), true);
    assert.equal(base.doGenerateCalls.length, 2);
    assert.equal(base.doGenerateCalls[0].tools?.length, 1);
    assert.deepEqual(base.doGenerateCalls[1].toolChoice, { type: "none" });
  });
}

describe("what the CLI Proxy receives for a widget investigation", () => {
  // What eve sends an anthropic.messages model: its last tool, its last system
  // message, and the last message and last assistant message carry a marker.
  const MARK = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;
  const LISTED = [
    "widget_account_access",
    "widget_billing_summary",
    "widget_file_ticket",
    "widget_help_article",
    "widget_read_help_article",
  ];
  const tools = ["bash", ...LISTED].map((name, n, all) => ({
    description: `Reads ${name}.`,
    inputSchema: { type: "object" as const },
    name,
    type: "function" as const,
    ...(n === all.length - 1 ? { providerOptions: MARK } : {}),
  }));
  const READS = [
    "widget_billing_summary",
    "widget_account_access",
    "widget_read_help_article",
  ];
  const eveParams = (userId: string, reads: number, question: string) => {
    const history = READS.slice(0, reads).flatMap((toolName, n) => [
      {
        content: [
          {
            input: {},
            toolCallId: `c${n}`,
            toolName,
            type: "tool-call" as const,
          },
        ],
        role: "assistant" as const,
      },
      {
        content: [
          {
            output: { type: "json" as const, value: { ok: true } },
            toolCallId: `c${n}`,
            toolName,
            type: "tool-result" as const,
          },
        ],
        role: "tool" as const,
      },
    ]);
    const messages = [
      {
        content: [{ text: question, type: "text" as const }],
        role: "user" as const,
      },
      ...history,
    ];
    const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
    return {
      prompt: [
        {
          content: composePrompt(sessionLane(widgetAuth({ ...scope, userId }))),
          providerOptions: MARK,
          role: "system" as const,
        },
        ...messages.map((message, n) =>
          n === messages.length - 1 || n === lastAssistant
            ? { ...message, providerOptions: MARK }
            : message
        ),
      ],
      tools,
    } as Parameters<ReturnType<typeof wrapLanguageModel>["doGenerate"]>[0];
  };
  interface Body {
    messages: { content: { cache_control?: unknown; text?: string }[] }[];
    model: string;
    system: { cache_control?: unknown; text: string }[];
    tools?: unknown[];
  }
  const session = async (
    userId: string,
    picks: string[],
    steps: number[],
    question = "Why was I charged?"
  ) => {
    const bodies: Body[] = [];
    const conversations: string[] = [];
    const warnings: unknown[] = [];
    const provider = createAnthropic({
      apiKey: "test",
      baseURL: "https://proxy.test/v1",
      fetch: (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        const forced =
          body.tool_choice?.type === "tool" ? body.tool_choice.name : undefined;
        return Promise.resolve(
          Response.json({
            content: forced
              ? [{ id: "t", input: {}, name: forced, type: "tool_use" }]
              : [{ text: "findings", type: "text" }],
            id: "msg",
            model: body.model,
            role: "assistant",
            stop_reason: forced ? "tool_use" : "end_turn",
            stop_sequence: null,
            type: "message",
            usage: { input_tokens: 1, output_tokens: 1 },
          })
        );
      },
    });
    const jev = (_url: string, init: { body: string }) => {
      conversations.push(JSON.parse(JSON.parse(init.body).state).conversation);
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            answers: {
              action: { choice: picks.shift(), confidence: 0.9 },
              handoff_eligible: { noul: 0 },
            },
          }),
        ok: true,
        status: 200,
      });
    };
    const model = wrapLanguageModel({
      middleware: [
        widgetInvestigationMiddleware(),
        simulateStreamingMiddleware(),
        widgetNextActionMiddleware({
          apiKey: "k",
          fetch: jev,
          stepModel: wrapLanguageModel({
            middleware: [],
            model: provider("claude-haiku-5-5"),
          }),
        }),
      ],
      model: provider("claude-sonnet-5-5"),
    });
    for (const reads of steps) {
      // biome-ignore lint/performance/noAwaitInLoops: one session's steps run in order.
      const output = await model.doGenerate(eveParams(userId, reads, question));
      warnings.push(...output.warnings);
    }
    return Object.assign(bodies, { conversations, warnings });
  };
  const A = "00000000-0000-4000-8000-00000000000a";
  const B = "00000000-0000-4000-8000-00000000000b";

  it("sends Jev the customer conversation without the cached guide on initial and tool-result steps", async () => {
    const questions = ["Why was I charged?", "My campaign stopped sending"];
    const conversations = await Promise.all(
      questions.map(async (question) => {
        const bodies = await session(
          A,
          ["widget_billing_summary", "finish"],
          [0, 1],
          question
        );
        assert.equal(bodies.conversations.length, 2);
        for (const conversation of bodies.conversations) {
          assert.ok(conversation.includes(question));
          assert.equal(conversation.includes("# Product guide"), false);
          assert.equal(conversation, question);
        }
        return bodies.conversations;
      })
    );
    assert.notDeepEqual(conversations[0], conversations[1]);
  });

  it("lists the same tools across forced reads and terminal steps", async () => {
    // Two picked reads on the step model, then the write-up and an article read
    // before the finish on the main model.
    const bodies = await session(
      A,
      ["widget_billing_summary", "widget_account_access", "finish"],
      [0, 1, 2, 3]
    );
    assert.deepEqual(
      bodies.map((body) => body.model),
      [
        "claude-haiku-5-5",
        "claude-haiku-5-5",
        "claude-sonnet-5-5",
        "claude-sonnet-5-5",
      ]
    );
    for (const body of bodies) {
      assert.deepEqual(body.tools, bodies[0].tools);
    }
    assert.deepEqual(
      (bodies[0].tools as { name: string }[]).map((entry) => entry.name),
      LISTED
    );
  });

  it("asks for at most four cache breakpoints, none of them on a tool", async () => {
    const bodies = await session(
      A,
      ["widget_billing_summary", "widget_account_access", "finish"],
      [0, 1, 2, 3]
    );
    for (const body of bodies) {
      const marks = JSON.stringify(body).match(/"cache_control"/g) ?? [];
      assert.ok(marks.length <= 4, `${body.model}: ${marks.length}`);
      assert.equal(JSON.stringify(body.tools).includes("cache_control"), false);
    }
    // The provider drops a fifth breakpoint with a warning, whichever it is.
    assert.equal(JSON.stringify(bodies.warnings).includes("breakpoint"), false);
  });

  it("leads the first user message with the cached guide, byte-identical across questions, workspaces and steps", async () => {
    const prefixes = new Map<string, string>();
    for (const [userId, question] of [
      [A, "Why was I charged?"],
      [B, "My campaign stopped sending"],
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: compare consecutive steps of each session.
      const bodies = await session(
        userId,
        ["widget_billing_summary", "widget_account_access", "finish"],
        [0, 1, 2, 3],
        question
      );
      assert.deepEqual(
        bodies.map((body) => body.model),
        [
          "claude-haiku-5-5",
          "claude-haiku-5-5",
          "claude-sonnet-5-5",
          "claude-sonnet-5-5",
        ]
      );
      for (const body of bodies) {
        assert.equal(
          JSON.stringify(body.system).includes(PRODUCT_GUIDE),
          false
        );
        assert.ok(body.system.some((block) => block.text.includes(userId)));
        const [first, next] = body.messages[0].content;
        if (body.model === "claude-haiku-5-5") {
          // The step-filler only fills in the chosen read: it gets no guide.
          assert.equal(JSON.stringify(body).includes(PRODUCT_GUIDE), false);
          assert.equal(first.text, question);
          continue;
        }
        assert.ok(first.text?.endsWith(PRODUCT_GUIDE));
        assert.ok(first.cache_control);
        assert.equal(next.text, question);
        const prefix = JSON.stringify({ guide: first, tools: body.tools });
        const previous = prefixes.get(body.model);
        if (previous !== undefined) {
          assert.equal(prefix, previous);
        }
        prefixes.set(body.model, prefix);
      }
    }
    assert.equal(prefixes.size, 1);
  });
});
