import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { simulateStreamingMiddleware, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { widgetInvestigationMiddleware } from "./widget-investigation-model.js";
import {
  nextActionEnabled,
  widgetNextActionMiddleware,
} from "./widget-next-action.js";

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const TOOLS = [
  "widget_account_access",
  "widget_billing_summary",
  "widget_file_ticket",
  "widget_generation_diagnostics",
  "widget_help_article",
  "widget_inbox_health",
  "widget_outreach_health",
  "widget_provisioning_status",
  "widget_read_help_article",
  "widget_website_status",
  "web_fetch",
].map((name) => ({
  // Longer than the old 300-character cut, with the caveat at the very end.
  description: `Reads ${name}. ${"x".repeat(400)} CANNOT_TIE_ORDER_TO_CHARGE`,
  inputSchema: { type: "object" as const },
  name,
  type: "function" as const,
}));

const text = (value: string) => ({
  content: [{ text: value, type: "text" as const }],
  finishReason: { raw: "stop", unified: "stop" as const },
  usage,
  warnings: [],
});
const call = (toolName: string, input: object) => ({
  content: [
    {
      input: JSON.stringify(input),
      toolCallId: "next",
      toolName,
      type: "tool-call" as const,
    },
  ],
  finishReason: { raw: "tool_calls", unified: "tool-calls" as const },
  usage,
  warnings: [],
});

/** A turn that has already made these reads and just received their results. */
const prompt = (
  question: string,
  reads: { input: object; output: unknown; tool: string }[]
) => [
  { content: "instructions", role: "system" as const },
  {
    content: [{ text: question, type: "text" as const }],
    role: "user" as const,
  },
  ...reads.flatMap((read, index) => [
    {
      content: [
        { text: "private reasoning", type: "reasoning" as const },
        {
          input: read.input,
          toolCallId: `c${index}`,
          toolName: read.tool,
          type: "tool-call" as const,
        },
      ],
      role: "assistant" as const,
    },
    {
      content: [
        {
          output: { type: "json" as const, value: read.output as never },
          toolCallId: `c${index}`,
          toolName: read.tool,
          type: "tool-result" as const,
        },
      ],
      role: "tool" as const,
    },
  ]),
];

const jev =
  (choice: string, eligible = 0, seen: { state?: string }[] = []) =>
  (_url: string, init: { body: string }) => {
    seen.push(JSON.parse(init.body));
    return Promise.resolve({
      json: () =>
        Promise.resolve({
          answers: {
            action: { choice, confidence: 0.9 },
            handoff_eligible: { noul: eligible },
          },
        }),
      ok: true,
      status: 200,
    });
  };

function harness(
  fetch: Parameters<typeof widgetNextActionMiddleware>[0] extends infer O
    ? O extends { fetch?: infer F }
      ? F
      : never
    : never,
  ...results: ReturnType<typeof text | typeof call>[]
) {
  const base = new MockLanguageModelV4({
    doGenerate: () => Promise.resolve(results.shift() ?? text("findings")),
  });
  const model = wrapLanguageModel({
    middleware: [
      widgetInvestigationMiddleware(),
      simulateStreamingMiddleware(),
      widgetNextActionMiddleware({ apiKey: "k", fetch, sessionId: "s" }),
    ],
    model: base,
  });
  const sent = (n = 0) => {
    const params = base.doGenerateCalls[n];
    const last = params.prompt.at(-1);
    return {
      note:
        last?.role === "user" && last.content[0]?.type === "text"
          ? last.content[0].text
          : "",
      toolChoice: params.toolChoice,
      tools: (params.tools ?? []).map((tool) => tool.name),
    };
  };
  return { base, model, sent };
}

const RE_0 = /Did my site finish building/;
const RE_1 = /unavailable/;
const RE_2 = /savedBuild/;
const RE_3 = /private reasoning/;
const RE_4 = /widget_file_ticket|web_fetch/;
const RE_5 = /single detail/;
const RE_6 = /does not need to take over/;
const RE_7 = /could not be checked/;
const RE_8 = /not a reason for a person/;
const RE_9 = /A person should take over/;
const RE_10 = /Stop gathering/;

const WRITE_UP_TOOLS = [
  "widget_file_ticket",
  "widget_help_article",
  "widget_read_help_article",
];

const campaigns = {
  campaigns: [
    { name: "A", status: "paused" },
    { name: "B", status: "paused" },
  ],
};

describe("widget next-action selector", () => {
  it("is opt-in and never on in production", () => {
    assert.equal(nextActionEnabled({}), false);
    assert.equal(nextActionEnabled({ WIDGET_NEXT_ACTION: "jev" }), true);
    assert.equal(
      nextActionEnabled({
        VERCEL_ENV: "production",
        WIDGET_NEXT_ACTION: "jev",
      }),
      false
    );
  });

  it("leaves the first step to the investigator: no selector call before any tool result", async () => {
    let called = false;
    const { model, sent } = harness(() => {
      called = true;
      throw new Error("unused");
    });
    await model.doGenerate({
      prompt: prompt("Why was I charged?", []),
      tools: TOOLS,
    });
    assert.equal(called, false);
    assert.equal(sent().tools.includes("widget_billing_summary"), true);
    assert.equal(sent().tools.includes("web_fetch"), false);
  });

  // One available read per investigation area: the pick is the only tool the
  // investigator is offered, and it is forced to call it.
  for (const [area, question, done, pick] of [
    [
      "campaigns",
      "Why did campaign A stop?",
      "widget_inbox_health",
      "widget_outreach_health",
    ],
    [
      "inbox health",
      "Are my inboxes broken?",
      "widget_outreach_health",
      "widget_inbox_health",
    ],
    [
      "generation",
      "Why was my draft blocked?",
      "widget_outreach_health",
      "widget_generation_diagnostics",
    ],
    [
      "provisioning",
      "Where are my new inboxes?",
      "widget_billing_summary",
      "widget_provisioning_status",
    ],
    [
      "billing",
      "Why was I charged yesterday?",
      "widget_account_access",
      "widget_billing_summary",
    ],
    [
      "account access",
      "Why can't my teammate sign in?",
      "widget_billing_summary",
      "widget_account_access",
    ],
    [
      "websites",
      "Why does my site show 404?",
      "widget_account_access",
      "widget_website_status",
    ],
  ] as const) {
    it(`${area}: a read decision forces exactly that tool`, async () => {
      const { model, sent } = harness(jev(pick), call(pick, { page: 1 }));
      const out = await model.doGenerate({
        prompt: prompt(question, [
          { input: {}, output: { ok: true }, tool: done },
        ]),
        tools: TOOLS,
      });
      assert.deepEqual(sent().tools, [pick]);
      assert.deepEqual(sent().toolChoice, { toolName: pick, type: "tool" });
      assert.equal(out.content[0]?.type, "tool-call");
    });
  }

  it("sends Jev the question, reads, results and remaining tools, and never reasoning, the ticket tool or a disallowed tool", async () => {
    const seen: { state?: string }[] = [];
    const { model } = harness(jev("finish", 0, seen));
    await model.doGenerate({
      prompt: prompt("Did my site finish building?", [
        {
          input: { site: "x" },
          output: { liveHosting: "unavailable", savedBuild: "completed" },
          tool: "widget_website_status",
        },
      ]),
      tools: TOOLS,
    });
    const body = JSON.stringify(seen[0]);
    assert.match(body, RE_0);
    assert.match(body, RE_1);
    assert.match(body, RE_2);
    assert.doesNotMatch(body, RE_3);
    assert.doesNotMatch(body, RE_4);
  });

  it("finish keeps the help center readable so a product step can rest on an article, and an article read is a normal next checkpoint", async () => {
    const seen: { state?: string }[] = [];
    const { model, sent } = harness(
      jev("finish", 0, seen),
      call("widget_read_help_article", { url: "https://help.example/launch" })
    );
    const first = await model.doGenerate({
      prompt: prompt("How do I get campaign A sending again?", [
        { input: {}, output: campaigns, tool: "widget_outreach_health" },
      ]),
      tools: TOOLS,
    });
    assert.deepEqual(sent().tools, WRITE_UP_TOOLS);
    assert.equal(sent().toolChoice, undefined);
    assert.equal(first.content[0]?.type, "tool-call");
    await model.doGenerate({
      prompt: prompt("How do I get campaign A sending again?", [
        { input: {}, output: campaigns, tool: "widget_outreach_health" },
        {
          input: { url: "https://help.example/launch" },
          output: { text: "Open the campaign and choose Resume." },
          tool: "widget_read_help_article",
        },
      ]),
      tools: TOOLS,
    });
    assert.equal(seen.length, 2);
    assert.equal(JSON.stringify(seen[1]).includes("choose Resume"), true);
  });

  it("the selector reads each tool's whole description, caveats included", async () => {
    const seen: { state?: string }[] = [];
    const { model } = harness(jev("finish", 0, seen));
    await model.doGenerate({
      prompt: prompt("Why was I charged?", [
        { input: {}, output: {}, tool: "widget_account_access" },
      ]),
      tools: TOOLS,
    });
    assert.equal(
      JSON.stringify(seen[0]).includes("CANNOT_TIE_ORDER_TO_CHARGE"),
      true
    );
  });

  it("clarify removes the evidence tools and asks for one detail without a handoff", async () => {
    const { model, sent } = harness(jev("clarify"));
    await model.doGenerate({
      prompt: prompt("Why did my campaign stop?", [
        { input: {}, output: campaigns, tool: "widget_outreach_health" },
      ]),
      tools: TOOLS,
    });
    assert.deepEqual(sent().tools, WRITE_UP_TOOLS);
    assert.match(sent().note, RE_5);
    assert.match(sent().note, RE_6);
  });

  it("a useful partial answer: an unavailable source finishes with limitations, not a person", async () => {
    const { model, sent } = harness(jev("finish"));
    await model.doGenerate({
      prompt: prompt("Are any inboxes broken?", [
        {
          input: {},
          output: { live: "unavailable", savedErrors: 0 },
          tool: "widget_inbox_health",
        },
      ]),
      tools: TOOLS,
    });
    assert.match(sent().note, RE_7);
    assert.match(sent().note, RE_8);
    assert.equal(sent().toolChoice, undefined);
  });

  it("a human pick stands for an explicit request and for a complex billing dispute", async () => {
    for (const question of [
      "Please connect me with a person.",
      "I was charged twice for the same inbox order across my workspaces.",
    ]) {
      const { model, sent } = harness(jev("human", 0.9));
      // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh harness, in order.
      await model.doGenerate({
        prompt: prompt(question, [
          { input: {}, output: { charges: 1 }, tool: "widget_billing_summary" },
        ]),
        tools: TOOLS,
      });
      assert.match(sent().note, RE_9);
      // Reconciling never widens the reads: no evidence tool is left to call.
      assert.deepEqual(sent().tools, ["widget_file_ticket"]);
    }
  });

  it("a human pick that is not eligible becomes a finish, never a handoff", async () => {
    const { model, sent } = harness(jev("human", 0.2));
    await model.doGenerate({
      prompt: prompt("Are my inboxes ok?", [
        {
          input: {},
          output: { historical: "old order counts differ", live: "failed" },
          tool: "widget_inbox_health",
        },
      ]),
      tools: TOOLS,
    });
    assert.doesNotMatch(sent().note, RE_9);
    assert.match(sent().note, RE_8);
  });

  it("an exhausted read is not repeated: the identical call is dropped and the step redone as a finish", async () => {
    const { base, model, sent } = harness(
      jev("widget_outreach_health"),
      call("widget_outreach_health", { a: 1, b: 2 }),
      text("findings")
    );
    const out = await model.doGenerate({
      prompt: prompt("Why did campaign A stop?", [
        {
          input: { a: 1, b: 2 },
          output: campaigns,
          tool: "widget_outreach_health",
        },
      ]),
      tools: TOOLS,
    });
    assert.equal(base.doGenerateCalls.length, 2);
    assert.deepEqual(sent(1).tools, WRITE_UP_TOOLS);
    assert.match(sent(1).note, RE_10);
    assert.deepEqual(out.content, [{ text: "findings", type: "text" }]);
  });

  it("a new argument on the same tool is a new read and goes through", async () => {
    const { base, model } = harness(
      jev("widget_outreach_health"),
      call("widget_outreach_health", { cursor: "p2" })
    );
    const out = await model.doGenerate({
      prompt: prompt("Why did campaign A stop?", [
        {
          input: {},
          output: { ...campaigns, next: "p2" },
          tool: "widget_outreach_health",
        },
      ]),
      tools: TOOLS,
    });
    assert.equal(base.doGenerateCalls.length, 1);
    assert.equal(out.content[0]?.type, "tool-call");
  });

  it("scope: a pick outside the allowlist, or of the ticket tool, is invalid and falls back", async () => {
    for (const pick of [
      "web_fetch",
      "widget_file_ticket",
      "other_workspace_lookup",
    ]) {
      const { model, sent } = harness(jev(pick));
      // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh harness, in order.
      await model.doGenerate({
        prompt: prompt("Check my other workspace.", [
          { input: {}, output: {}, tool: "widget_account_access" },
        ]),
        tools: TOOLS,
      });
      assert.equal(sent().toolChoice, undefined);
      assert.equal(sent().note, "");
      assert.equal(sent().tools.includes("web_fetch"), false);
      assert.equal(sent().tools.length, TOOLS.length - 1);
    }
  });

  it("a selector timeout, error or malformed answer leaves the existing investigation untouched, with no handoff note", async () => {
    const failures = [
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      () =>
        Promise.resolve({
          json: () => Promise.resolve({}),
          ok: false,
          status: 500,
        }),
      () =>
        Promise.resolve({
          json: () => Promise.resolve({ answers: {} }),
          ok: true,
          status: 200,
        }),
    ];
    for (const fetch of failures) {
      const { model, sent } = harness(fetch);
      // biome-ignore lint/performance/noAwaitInLoops: each case needs its own fresh harness, in order.
      await model.doGenerate({
        prompt: prompt("Why was I charged?", [
          { input: {}, output: {}, tool: "widget_billing_summary" },
        ]),
        tools: TOOLS,
      });
      assert.equal(sent().note, "");
      assert.equal(sent().toolChoice, undefined);
      assert.equal(sent().tools.length, TOOLS.length - 1);
    }
  });

  it("a provider that refuses the forced read falls back to the unforced step", async () => {
    let first = true;
    const base = new MockLanguageModelV4({
      doGenerate: () => {
        if (first) {
          first = false;
          return Promise.reject(new Error("tool_choice unsupported"));
        }
        return Promise.resolve(text("findings"));
      },
    });
    const model = wrapLanguageModel({
      middleware: [
        widgetInvestigationMiddleware(),
        widgetNextActionMiddleware({
          apiKey: "k",
          fetch: jev("widget_inbox_health"),
        }),
      ],
      model: base,
    });
    await model.doGenerate({
      prompt: prompt("Inboxes?", [
        { input: {}, output: {}, tool: "widget_outreach_health" },
      ]),
      tools: TOOLS,
    });
    assert.equal(base.doGenerateCalls[1].toolChoice, undefined);
    assert.equal(
      (base.doGenerateCalls[1].tools ?? []).length,
      TOOLS.length - 1
    );
  });

  it("the tool budget still wins: once spent there is nothing to select and no selector call", async () => {
    let called = false;
    const { model, sent } = harness(() => {
      called = true;
      throw new Error("unused");
    });
    await model.doGenerate({
      prompt: prompt(
        "Why?",
        Array.from({ length: 14 }, (_, page) => ({
          input: { page },
          output: {},
          tool: "widget_outreach_health",
        }))
      ),
      tools: TOOLS,
    });
    assert.equal(called, false);
    assert.deepEqual(sent().tools, []);
  });

  it("the decision holds on the streaming path Eve uses", async () => {
    const { model, sent } = harness(
      jev("widget_website_status"),
      call("widget_website_status", { live: true })
    );
    const { stream } = await model.doStream({
      prompt: prompt("Why does my site 404?", [
        { input: {}, output: {}, tool: "widget_account_access" },
      ]),
      tools: TOOLS,
    });
    const types: string[] = [];
    for await (const part of stream as unknown as AsyncIterable<{
      type: string;
    }>) {
      types.push(part.type);
    }
    assert.deepEqual(sent().tools, ["widget_website_status"]);
    assert.equal(types.includes("tool-call"), true);
  });
});
