import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { simulateStreamingMiddleware, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { widgetInvestigationMiddleware } from "./widget-investigation-model.js";
import {
  nextActionEnabled,
  note,
  selectNextAction,
  turnEvidence,
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

  it("selects the first useful read without reclassifying intent or ambiguity", async () => {
    const seen: {
      state?: string;
      questions?: { action: { criteria: object }; handoff_eligible?: unknown };
    }[] = [];
    const { model, sent } = harness(
      jev("widget_billing_summary", 0, seen),
      call("widget_billing_summary", {})
    );
    await model.doGenerate({
      prompt: prompt("Why was I charged?", []),
      tools: TOOLS,
    });
    assert.deepEqual(sent().tools, ["widget_billing_summary"]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].questions?.handoff_eligible, undefined);
    assert.equal("clarify" in (seen[0].questions?.action.criteria ?? {}), true);
    assert.equal("human" in (seen[0].questions?.action.criteria ?? {}), false);
    assert.deepEqual(JSON.parse(seen[0].state ?? "{}").completedReads, []);
  });

  it("can request customer-only evidence before any workspace read", async () => {
    const ask = {
      description: "Record the question",
      inputSchema: { type: "object" as const },
      name: "widget_ask_customer",
      type: "function" as const,
    };
    const { model, sent } = harness(
      jev("clarify"),
      call("widget_ask_customer", {
        question: "What busy times does your calendar show in that window?",
      })
    );
    await model.doGenerate({
      prompt: prompt("Is my calendar free tomorrow from 9 to 5 Eastern?", []),
      tools: [...TOOLS, ask],
    });
    assert.deepEqual(sent().tools, ["widget_ask_customer"]);
    assert.deepEqual(sent().toolChoice, {
      toolName: "widget_ask_customer",
      type: "tool",
    });
  });
  it("one selected read cannot dispatch twelve parameter variants or duplicates", async () => {
    const batch = call("widget_outreach_health", {});
    batch.content = Array.from({ length: 12 }, (_, n) => ({
      ...batch.content[0],
      input: JSON.stringify(n < 2 ? {} : { after: `page-${n}` }),
      toolCallId: `batch-${n}`,
    }));
    const { model, base } = harness(jev("widget_outreach_health"), batch);
    const out = await model.doGenerate({
      prompt: prompt("Check campaign A", []),
      tools: TOOLS,
    });
    assert.equal(base.doGenerateCalls.length, 1);
    assert.deepEqual(out.content, [batch.content[0]]);
  });

  it("a repeated call in a batch cannot discard a distinct useful page", async () => {
    const batch = call("widget_outreach_health", {});
    batch.content.push({
      ...batch.content[0],
      input: JSON.stringify({ after: "page2" }),
      toolCallId: "page2",
    });
    const { model, base } = harness(jev("widget_outreach_health"), batch);
    const out = await model.doGenerate({
      prompt: prompt("Check the next campaign", [
        {
          input: {},
          output: { nextAfter: "page2" },
          tool: "widget_outreach_health",
        },
      ]),
      tools: TOOLS,
    });
    assert.equal(base.doGenerateCalls.length, 1);
    assert.deepEqual(out.content, [batch.content[1]]);
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

  it("keeps diagnostic evidence beyond 3k while sharing the total evidence budget", async () => {
    const seen: { state?: string }[] = [];
    const { model } = harness(jev("finish", 0, seen));
    await model.doGenerate({
      prompt: prompt("Inspect the named website", [
        {
          input: {},
          output: {
            caveats: "x".repeat(4000),
            publicCheck: { dns: "no_records" },
          },
          tool: "widget_website_status",
        },
        {
          input: { inspectWebsiteId: "selected" },
          output: {
            caveats: "x".repeat(4000),
            publicCheck: { dns: "no_records" },
            trailing: "x".repeat(50_000),
          },
          tool: "widget_website_status",
        },
      ]),
      tools: TOOLS,
    });
    const reads = JSON.parse(seen[0].state ?? "{}").completedReads;
    assert.ok(
      reads.every((read: { result: string }) =>
        read.result.includes('"dns":"no_records"')
      )
    );
    assert.ok(reads[1].result.includes("[cut here for length"));
    assert.ok(reads[1].result.length < 24_100);
  });

  it("finish is terminal: an article read to ground a step does not reopen workspace reads or ask Jev again", async () => {
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
    // wrun_41M32MCAVG0GN0CZ5AYEW3AYV8: finish, finish, then a forced outreach read.
    assert.equal(seen.length, 1);
    assert.deepEqual(sent(1).tools, WRITE_UP_TOOLS);
    assert.equal(sent(1).toolChoice, undefined);
  });

  it("legitimate reads before finishing are kept: articles the investigator read first do not end the gathering", async () => {
    const seen: { state?: string }[] = [];
    const { model, sent } = harness(
      jev("widget_outreach_health", 0, seen),
      call("widget_outreach_health", {})
    );
    await model.doGenerate({
      prompt: prompt("How do I get campaign A sending again?", [
        {
          input: { query: "resume campaign" },
          output: { articles: [] },
          tool: "widget_help_article",
        },
      ]),
      tools: TOOLS,
    });
    assert.equal(seen.length, 1);
    assert.deepEqual(sent().tools, ["widget_outreach_health"]);
  });

  it("a tool that has already run is offered to Jev as a re-read with its own bar, for every tool alike", async () => {
    const seen: {
      questions?: { action?: { criteria?: Record<string, string> } };
    }[] = [];
    const { model } = harness(jev("finish", 0, seen as never));
    await model.doGenerate({
      prompt: prompt("Why did my campaign stop?", [
        { input: {}, output: campaigns, tool: "widget_outreach_health" },
      ]),
      tools: TOOLS,
    });
    const criteria = seen[0].questions?.action?.criteria ?? {};
    const lead = (tool: string) => criteria[tool].split(":")[0];
    assert.notEqual(
      lead("widget_outreach_health"),
      lead("widget_inbox_health")
    );
    assert.equal(lead("widget_inbox_health"), lead("widget_billing_summary"));
  });

  it("Jev is never offered an article or the ticket tool as a read", async () => {
    const seen: { questions?: { action?: { criteria?: object } } }[] = [];
    const { model } = harness(jev("finish", 0, seen as never));
    await model.doGenerate({
      prompt: prompt("Why did campaign A stop?", [
        { input: {}, output: campaigns, tool: "widget_outreach_health" },
      ]),
      tools: TOOLS,
    });
    const menu = Object.keys(seen[0].questions?.action?.criteria ?? {});
    assert.equal(menu.includes("widget_outreach_health"), true);
    assert.equal(
      menu.some(
        (key) => key.includes("help_article") || key.includes("ticket")
      ),
      false
    );
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

  it("clarify forces the ask tool, which the investigator is never offered otherwise, and the recorded question ends the turn without Jev", async () => {
    const ASK = {
      description: "Record the question",
      inputSchema: { type: "object" as const },
      name: "widget_ask_customer",
      type: "function" as const,
    };
    const seen: { state?: string }[] = [];
    const { model, sent } = harness(
      jev("clarify", 0, seen),
      call("widget_ask_customer", { question: "Which campaign do you mean?" })
    );
    const reads = [
      { input: {}, output: campaigns, tool: "widget_outreach_health" },
    ];
    await model.doGenerate({
      prompt: prompt("Why did my campaign stop?", reads),
      tools: [...TOOLS, ASK],
    });
    assert.deepEqual(sent().tools, ["widget_ask_customer"]);
    assert.deepEqual(sent().toolChoice, {
      toolName: "widget_ask_customer",
      type: "tool",
    });
    assert.equal(
      JSON.stringify(seen[0]).includes("widget_ask_customer"),
      false
    );
    await model.doGenerate({
      prompt: prompt("Why did my campaign stop?", [
        ...reads,
        {
          input: { question: "Which campaign do you mean?" },
          output: { asked: "Which campaign do you mean?" },
          tool: "widget_ask_customer",
        },
      ]),
      tools: [...TOOLS, ASK],
    });
    assert.equal(seen.length, 1);
    assert.deepEqual(sent(1).tools, []);
    // A read or a fallback step never exposes it.
    const other = harness(() => Promise.reject(new Error("down")));
    await other.model.doGenerate({
      prompt: prompt("Why did my campaign stop?", reads),
      tools: [...TOOLS, ASK],
    });
    assert.equal(other.sent().tools.includes("widget_ask_customer"), false);
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

  it("a stalled forced request aborts and the streaming path falls back with the original signal", async (t) => {
    const parent = new AbortController();
    const local = new AbortController();
    t.mock.method(AbortSignal, "timeout", (ms: number) => {
      assert.ok(ms === 3000 || ms === 15_000);
      return ms === 15_000 && !local.signal.aborted
        ? local.signal
        : new AbortController().signal;
    });
    let calls = 0;
    const base = new MockLanguageModelV4({
      doGenerate: (params) => {
        calls += 1;
        if (calls === 1) {
          assert.notEqual(params.abortSignal, parent.signal);
          local.abort(new DOMException("timed out", "TimeoutError"));
          assert.equal(params.abortSignal?.aborted, true);
          return Promise.reject(params.abortSignal?.reason);
        }
        assert.notEqual(params.abortSignal, parent.signal);
        assert.equal(params.abortSignal?.aborted, false);
        assert.equal(params.toolChoice, undefined);
        return Promise.resolve(text("recovered findings"));
      },
    });
    const model = wrapLanguageModel({
      middleware: [
        widgetInvestigationMiddleware(),
        simulateStreamingMiddleware(),
        widgetNextActionMiddleware({
          apiKey: "k",
          fetch: jev("widget_website_status"),
        }),
      ],
      model: base,
    });
    const { stream } = await model.doStream({
      abortSignal: parent.signal,
      prompt: prompt("Check my website", []),
      tools: TOOLS,
    });
    let recovered = false;
    for await (const part of stream) {
      if (part.type === "text-delta" && part.delta === "recovered findings") {
        recovered = true;
      }
    }
    assert.equal(calls, 2);
    assert.ok(recovered);
  });

  it("a stalled write-up retries once with a fresh signal, including after a repeated read", async (t) => {
    const timers: AbortController[] = [];
    t.mock.method(AbortSignal, "timeout", () => {
      const timer = new AbortController();
      timers.push(timer);
      return timer.signal;
    });
    const base = new MockLanguageModelV4({
      doGenerate: (params) => {
        const n = base.doGenerateCalls.length;
        if (n === 1) {
          return Promise.resolve(call("widget_website_status", {}));
        }
        if (n === 2) {
          timers.at(-1)?.abort(new DOMException("timed out", "TimeoutError"));
          return Promise.reject(params.abortSignal?.reason);
        }
        assert.equal(params.abortSignal?.aborted, false);
        assert.equal(params.toolChoice, undefined);
        return Promise.resolve(text("DNS mismatch and HTTP 403"));
      },
    });
    const model = wrapLanguageModel({
      middleware: widgetNextActionMiddleware({
        apiKey: "k",
        fetch: jev("widget_website_status"),
      }),
      model: base,
    });
    const result = await model.doGenerate({
      prompt: prompt("Check my website", [
        {
          input: {},
          output: { status: "misconfigured" },
          tool: "widget_website_status",
        },
      ]),
      tools: TOOLS,
    });
    assert.equal(base.doGenerateCalls.length, 3);
    assert.deepEqual(result.content, text("DNS mismatch and HTTP 403").content);
  });

  it("an unforced request stops after one timeout retry and never retries parent cancellation", async (t) => {
    const timers: AbortController[] = [];
    t.mock.method(AbortSignal, "timeout", () => {
      const timer = new AbortController();
      timers.push(timer);
      return timer.signal;
    });
    for (const cancelParent of [false, true]) {
      const parent = new AbortController();
      const base = new MockLanguageModelV4({
        doGenerate: (params) => {
          if (cancelParent) {
            parent.abort(new DOMException("cancelled", "AbortError"));
          } else {
            timers.at(-1)?.abort(new DOMException("timed out", "TimeoutError"));
          }
          return Promise.reject(params.abortSignal?.reason);
        },
      });
      const model = wrapLanguageModel({
        middleware: widgetNextActionMiddleware(),
        model: base,
      });
      // biome-ignore lint/performance/noAwaitInLoops: independent cancellation cases.
      await assert.rejects(
        async () =>
          await model.doGenerate({
            abortSignal: parent.signal,
            prompt: prompt("Write the findings", []),
            tools: [],
          })
      );
      assert.equal(base.doGenerateCalls.length, cancelParent ? 1 : 2);
    }
  });

  it("cancelling the investigation aborts the forced request without starting its fallback", async () => {
    const parent = new AbortController();
    const cancelled = new DOMException("cancelled", "AbortError");
    const base = new MockLanguageModelV4({
      doGenerate: (params) => {
        parent.abort(cancelled);
        assert.equal(params.abortSignal?.aborted, true);
        return Promise.reject(params.abortSignal?.reason);
      },
    });
    const model = wrapLanguageModel({
      middleware: widgetNextActionMiddleware({
        apiKey: "k",
        fetch: jev("widget_website_status"),
      }),
      model: base,
    });
    await assert.rejects(
      async () =>
        await model.doGenerate({
          abortSignal: parent.signal,
          prompt: prompt("Check my website", []),
          tools: TOOLS,
        }),
      (error) => error === cancelled
    );
    assert.equal(base.doGenerateCalls.length, 1);
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

describe("repeat reads", () => {
  const billing = {
    description: "Billing summary",
    name: "widget_billing_summary",
  };
  const inbox = { description: "Inbox health", name: "widget_inbox_health" };
  const read = (n: number) => ({
    input: `{"page":${n}}`,
    result: "{}",
    tool: billing.name,
  });
  const pick =
    (choice: string, confidence: number, offered: string[][] = []) =>
    (_url: string, init: { body: string }) => {
      offered.push(
        Object.keys(JSON.parse(init.body).questions.action.criteria)
      );
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            answers: {
              action: { choice, confidence },
              handoff_eligible: { noul: 0 },
            },
          }),
        ok: true,
        status: 200,
      });
    };
  const select = (
    reads: ReturnType<typeof read>[],
    fetch: ReturnType<typeof pick>
  ) =>
    selectNextAction(
      { question: "can I get a refund?", reads, tools: [billing, inbox] },
      { apiKey: "k", fetch }
    );

  it("takes a read that ran twice off the menu", async () => {
    const offered: string[][] = [];
    await select([read(1), read(2)], pick("finish", 0.9, offered));
    assert.ok(!offered[0]?.includes(billing.name));
    assert.ok(offered[0]?.includes(inbox.name));
  });

  it("lets a re-read run at any confidence, so the next page is never cut off", async () => {
    assert.deepEqual(await select([read(1)], pick(billing.name, 0.46)), {
      action: "read",
      confidence: 0.46,
      tool: billing.name,
    });
  });
});

describe("control notes", () => {
  it("are never read as the customer's message, so a note cannot restart the turn", () => {
    const turn = prompt("why did my campaign stop?", [
      { input: {}, output: { ok: true }, tool: "widget_outreach_health" },
    ]);
    const plain = turnEvidence(turn as never);
    const noted = turnEvidence([
      ...turn,
      note("Stop workspace reads."),
    ] as never);
    assert.equal(noted.question, plain.question);
    assert.equal(noted.reads.length, 1);
    assert.equal(noted.atToolResult, plain.atToolResult);
  });
});

describe("step model", () => {
  const build = (choice: string, stepResult: ReturnType<typeof call>) => {
    const main = new MockLanguageModelV4({
      doGenerate: () => Promise.resolve(text("findings")),
    });
    const step = new MockLanguageModelV4({
      doGenerate: () => Promise.resolve(stepResult),
    });
    const model = wrapLanguageModel({
      middleware: [
        widgetInvestigationMiddleware(),
        simulateStreamingMiddleware(),
        widgetNextActionMiddleware({
          apiKey: "k",
          fetch: jev(choice),
          sessionId: "s",
          stepModel: wrapLanguageModel({ middleware: [], model: step }),
        }),
      ],
      model: main,
    });
    return { main, model, step };
  };

  it("fills in a read Jev picked, and never writes the findings", async () => {
    const { main, model, step } = build(
      "widget_billing_summary",
      call("widget_billing_summary", {})
    );
    await model.doGenerate({
      prompt: prompt("Why was I charged?", []),
      tools: TOOLS,
    });
    assert.equal(step.doGenerateCalls.length, 1);
    assert.deepEqual(
      step.doGenerateCalls[0].tools?.map((tool) => tool.name),
      ["widget_billing_summary"]
    );
    assert.equal(main.doGenerateCalls.length, 0);
  });

  it("leaves a finish write-up to the main model", async () => {
    const { main, model, step } = build(
      "finish",
      call("widget_billing_summary", {})
    );
    await model.doGenerate({
      prompt: prompt("Why was I charged?", [
        { input: {}, output: { ok: true }, tool: "widget_billing_summary" },
      ]),
      tools: TOOLS,
    });
    assert.equal(step.doGenerateCalls.length, 0);
    assert.equal(main.doGenerateCalls.length, 1);
  });
});
