import assert from "node:assert/strict";
import { test } from "node:test";
import { simulateStreamingMiddleware, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { toWidgetAsk, withHistory } from "./widget-investigation.js";
import { widgetInvestigationMiddleware } from "./widget-investigation-model.js";
import {
  handoffEligible,
  widgetNextActionMiddleware,
} from "./widget-next-action.js";
import { routeWidgetMessage } from "./widget-router.js";

/**
 * The context contract, checked on what each Jev request actually carries: the
 * router's, the post-tool selector's and the finish eligibility check's.
 */
interface Turn {
  role: "customer" | "assistant";
  text: string;
}
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const TOOLS = ["widget_outreach_health", "widget_inbox_health"].map((name) => ({
  description: `Reads ${name}`,
  inputSchema: { type: "object" as const },
  name,
  type: "function" as const,
}));
const ok = (answers: object) =>
  Promise.resolve({
    json: () => Promise.resolve({ answers }),
    ok: true,
    status: 200,
  });

async function routerState(latest: string, history: Turn[]) {
  let state = "";
  await routeWidgetMessage(toWidgetAsk(latest, history), {
    apiKey: "k",
    fetch: (_url, init) => {
      ({ state } = JSON.parse(init.body));
      return ok({
        asks_for_human: { noul: 0 },
        asks_own_data: { noul: 1 },
        lane: { choice: "investigate", confidence: 0.9 },
      });
    },
  });
  return state;
}

/** One post-tool checkpoint of a real investigation turn started with this conversation. */
async function selector(latest: string, history: Turn[], choice = "finish") {
  let conversation = "";
  const base = new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve({
        content: [{ text: "findings", type: "text" as const }],
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
        fetch: (_url, init) => {
          ({ conversation } = JSON.parse(JSON.parse(init.body).state));
          return ok({
            action: { choice, confidence: 0.9 },
            handoff_eligible: { noul: 0 },
          });
        },
      }),
    ],
    model: base,
  });
  await model.doGenerate({
    prompt: [
      {
        content: [{ text: withHistory(latest, history), type: "text" }],
        role: "user",
      },
      {
        content: [
          {
            input: {},
            toolCallId: "c",
            toolName: "widget_outreach_health",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: {
              type: "json",
              value: { campaigns: ["Spring Promo", "Autumn Promo"] },
            },
            toolCallId: "c",
            toolName: "widget_outreach_health",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ],
    tools: TOOLS,
  });
  return { conversation, sent: base.doGenerateCalls[0] };
}

const filler = (n: number): Turn[] =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 ? ("assistant" as const) : ("customer" as const),
    text: `filler ${i} ${"x".repeat(1990)}`,
  }));

test("the longest accepted history cannot cut off the latest question, for the router, the selector or the eligibility check", async () => {
  const latest = `${"q".repeat(3990)} END-OF-Q`;
  const history = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? ("assistant" as const) : ("customer" as const),
    text: "h".repeat(4000),
  }));
  assert.equal((await routerState(latest, history)).includes(latest), true);
  assert.equal(
    (await selector(latest, history)).conversation.includes(latest),
    true
  );
  let eligibility = "";
  await handoffEligible(
    {
      conversation: withHistory(latest, history),
      findings: { facts: [], recommendation: "r" },
    },
    {
      apiKey: "k",
      fetch: (_url, init) => {
        eligibility = JSON.parse(JSON.parse(init.body).state).conversation;
        return ok({ handoff_eligible: { noul: 0 } });
      },
    }
  );
  assert.equal(eligibility.includes(latest), true);
});

test('"that campaign" arrives with the exchange that names it, roles kept, in the same words for the router and the selector', async () => {
  const history: Turn[] = [
    { role: "customer", text: "My Spring Promo campaign looks stuck." },
    { role: "assistant", text: "Spring Promo is paused. Do you want details?" },
  ];
  const latest = "yes, why did that campaign stop?";
  const router = await routerState(latest, history);
  const { conversation } = await selector(latest, history);
  assert.equal(router, conversation);
  assert.equal(
    router.includes("Customer: My Spring Promo campaign looks stuck."),
    true
  );
  assert.equal(router.includes("Support: Spring Promo is paused."), true);
  assert.equal(router.startsWith("LATEST CUSTOMER MESSAGE"), true);
});

test("a detail given more than four messages earlier is still there when Acquisity supplied it", async () => {
  const history: Turn[] = [
    { role: "customer", text: "It is the inbox sender@example.test." },
    ...Array.from({ length: 7 }, (_, i) => ({
      role: i % 2 ? ("customer" as const) : ("assistant" as const),
      text: `short turn ${i}`,
    })),
  ];
  const latest = "is it fixed now?";
  assert.equal(
    (await routerState(latest, history)).includes("sender@example.test"),
    true
  );
  assert.equal(
    (await selector(latest, history)).conversation.includes(
      "sender@example.test"
    ),
    true
  );
});

test("several plausible targets and nothing in the conversation to pick one: a clarify decision ends the reads", async () => {
  const { sent } = await selector("why did my campaign stop?", [], "clarify");
  assert.deepEqual(
    (sent.tools ?? []).map((tool) => tool.name),
    []
  );
  const last = sent.prompt.at(-1);
  assert.equal(last?.role, "user");
  assert.equal(JSON.stringify(last).includes("single detail"), true);
});

test("a topic change keeps the old identifier out of the latest message and says it does not carry over", async () => {
  const state = await routerState("separately, why was I charged yesterday?", [
    { role: "customer", text: "Campaign Spring Promo stopped sending." },
    { role: "assistant", text: "Spring Promo hit its daily limit." },
  ]);
  const [latestPart, earlierPart] = state.split("EARLIER TURNS");
  assert.equal(latestPart.includes("Spring Promo"), false);
  assert.equal(earlierPart.includes("Spring Promo"), true);
  assert.equal(earlierPart.includes("do not carry over"), true);
});

test("what did not fit is marked, newest turns win, and silence is never presented as proof", async () => {
  const history: Turn[] = [
    { role: "customer", text: "OLDEST campaign is Winter Sale" },
    ...filler(7),
    { role: "customer", text: `NEWEST ${"y".repeat(2500)}` },
  ];
  const state = await routerState("and now?", history);
  assert.equal(state.includes("older messages not shown]"), true);
  assert.equal(state.includes("OLDEST"), false);
  assert.equal(state.includes("NEWEST"), true);
  assert.equal(state.includes("[message cut here]"), true);
  assert.equal(state.includes("not proof the customer never gave it"), true);
  // Nothing omitted, nothing claimed.
  assert.equal(
    (await routerState("and now?", filler(2))).includes("not shown]"),
    false
  );
});

test("an identifier from another workspace in the conversation widens nothing: the read stays an allowlisted tool and no scope travels with it", async () => {
  const foreign = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const { conversation, sent } = await selector(
    `check workspace ${foreign} as well`,
    [{ role: "customer", text: `my other org is ${foreign}` }],
    "widget_inbox_health"
  );
  assert.deepEqual(
    (sent.tools ?? []).map((tool) => tool.name),
    ["widget_inbox_health"]
  );
  assert.deepEqual(sent.toolChoice, {
    type: "required",
  });
  // The selector is given the customer's words only; the verified scope is not
  // in its input to be argued with, and stays with the session and the tools.
  assert.equal(conversation.includes(foreign), true);
  assert.equal(sent.prompt.length, 4);
  assert.equal(sent.prompt.at(-1)?.role, "system");
});
