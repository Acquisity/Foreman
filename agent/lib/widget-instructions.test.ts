import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { composePrompt } from "./prompts.js";
import { sessionLane } from "./session-lane.js";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { CHAT_PROMPT } from "./widget-chat.js";
import { COMPOSER_PROMPT, composerRequest } from "./widget-egress.js";
import {
  cacheGuide,
  WIDGET_VOICE,
  widgetInstructions,
  withoutGuide,
} from "./widget-instructions.js";
import { JUDGE_TIMEOUT_MS } from "./widget-judge.js";
import { DESCRIPTION_CHARS } from "./widget-next-action.js";
import { PRODUCT_GUIDE } from "./widget-product-guide.js";
import { widgetAuth, widgetContext } from "./widget-scope.js";
import { SUPPORT_GUIDE } from "./widget-support-guide.js";

const FEATURE_OFF_NAMES =
  /These features are not turned on for this workspace: \["AI Website Creator"\]/u;
const FEATURE_OFF_NO_ASK =
  /do not say it could not be read or checked, and do not ask for details of it/u;
const FEATURE_OFF_NOT_GAP = /not a capability gap/u;
const FEATURE_OFF_AREAS =
  /These features are not turned on for this workspace: \["ai website creator"\]\. A feature that is off closes these whole areas for this workspace, so nothing in them can be read: \["website"\]/u;

test("shared support facts keep unpaid cleanup guidance without investigator tool commands", () => {
  for (const tool of [
    "widget_inbox_health",
    "widget_provisioning_status",
    "widget_billing_summary",
  ]) {
    assert.equal(SUPPORT_GUIDE.includes(tool), false);
  }
  assert.equal(SUPPORT_GUIDE.includes("before anything else"), false);
  assert.ok(
    SUPPORT_GUIDE.includes("Reconnect cannot bring back a cancelled mailbox")
  );
  assert.equal(
    SUPPORT_GUIDE.includes("Mailbox cancelled after unpaid cleanup"),
    false
  );
  assert.ok(
    SUPPORT_GUIDE.includes(
      "The customer cannot see an inbox's saved connection error"
    )
  );
});

const FAILED_STEP_RULE =
  /already tried the documented step and it failed[^.]*recent reconnect attempts all failed, do not tell them to repeat that step or wait it out: state what failed, with its error, and file it with widget_file_ticket/;
const NEXT_STEP_RULE =
  /ends with what the customer should do next: the steps[^.]*, the workaround for a[^.]*limitation, or the single most useful[^.]*check they can make/;
const NAMED_ACTOR_RULE =
  /When a finding names the person who did something in the workspace, keep that name in the reply: say "you" for such an action only when a finding says the customer did it, and never credit the customer with a teammate's change/;
const STATED_FINDING_RULE =
  /a recorded count, status or absence[^;]*goes in the reply as stated, never replaced by saying it could not be confirmed or checked; what a live check could not show is said after it, never instead of it/;
const NO_INVENTION_RULES = [
  /Never explain why data is missing unless/,
  /never offer a service, migration or team action/,
  /never promise to report[^.]* it later/,
  // wrun_41M4EWN90A0GKYHE33ARYJJB31 stated a pasted blocklist listing as fact.
  /pasted from another tool[^.]* is their report, not something checked here/,
];
const UNFILED_TICKET_RULE =
  /When ticketFiled is absent, nothing was reported[^.]*never say or suggest that this was reported, escalated or handed to engineering, billing or a person, even when the findings say it needs one/;

test("both lanes forbid unbacked reasons for missing data, invented services and report promises", () => {
  // Round 9: "may have been cleared when the subscription was cancelled",
  // "ask for that here in the chat" to move domains, "I'll report it to engineering".
  for (const prompt of [
    composePrompt(sessionLane(widgetAuth(scope))),
    COMPOSER_PROMPT,
  ]) {
    for (const rule of NO_INVENTION_RULES) {
      assert.match(prompt, rule);
    }
  }
});

test("a failed documented step is reported and filed as a ticket, never repeated", () => {
  assert.match(widgetInstructions(widgetAuth(scope)), FAILED_STEP_RULE);
});

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

const user = (text: string) => ({
  content: [{ text, type: "text" }],
  role: "user",
});
const investigator = (userId: string, question: string) =>
  cacheGuide<{ content: unknown; role: string }>([
    {
      content: composePrompt(sessionLane(widgetAuth({ ...scope, userId }))),
      role: "system",
    },
    user(question),
  ]);

test("the investigator leads the first user message with the cached guide, the same for every question and workspace", () => {
  const [first, second] = [
    investigator(A, "Why was I charged?"),
    investigator(B, "My campaign stopped sending"),
  ];
  for (const [prompt, userId] of [
    [first, A],
    [second, B],
  ] as const) {
    assert.ok(!String(prompt[0].content).includes(PRODUCT_GUIDE));
    assert.ok(String(prompt[0].content).includes(userId));
  }
  const [guide] = first[1].content as {
    providerOptions?: unknown;
    text: string;
  }[];
  assert.deepEqual(guide, (second[1].content as unknown[])[0]);
  assert.ok(guide.text.endsWith(SUPPORT_GUIDE));
  assert.deepEqual(guide.providerOptions, {
    anthropic: { cacheControl: { type: "ephemeral" } },
  });
});

test("the step-filler's prompt carries no guide", () => {
  const { prompt } = withoutGuide({ prompt: investigator(A, "Why?") });
  assert.ok(!JSON.stringify(prompt).includes(PRODUCT_GUIDE));
  assert.deepEqual(prompt[1], user("Why?"));
});

test("every composer reply shares one cached guide-first prefix and keeps the guide out of system", () => {
  const [first, second] = [
    composerRequest({
      findings: { facts: [] },
      question: "Why was I charged?",
    }),
    composerRequest({ findings: { facts: [1] }, question: "Is my inbox ok?" }),
  ];
  assert.ok(!first.system.includes(PRODUCT_GUIDE));
  assert.equal(first.system, second.system);
  const [guide, rest] = first.messages[0].content;
  assert.deepEqual(guide, second.messages[0].content[0]);
  assert.equal(guide.text, SUPPORT_GUIDE);
  assert.ok(guide.providerOptions);
  assert.ok(rest.text.includes("Why was I charged?"));
});

test("the chat and the reply composer share one voice", () => {
  assert.ok(CHAT_PROMPT.includes(WIDGET_VOICE));
  assert.ok(COMPOSER_PROMPT.includes(WIDGET_VOICE));
  assert.ok(!COMPOSER_PROMPT.includes("No greetings"));
});

test("the composer keeps a named teammate named instead of calling them you", () => {
  // ENG-20512: a teammate's CRM changes reached the customer as "all by you".
  assert.match(COMPOSER_PROMPT, NAMED_ACTOR_RULE);
});

test("without a filed ticket the composer never says it was reported", () => {
  assert.match(COMPOSER_PROMPT, UNFILED_TICKET_RULE);
});

test("the write-up and the reply both end with what the customer does next", () => {
  assert.match(COMPOSER_PROMPT, NEXT_STEP_RULE);
  assert.match(widgetInstructions(widgetAuth(scope)), NEXT_STEP_RULE);
});

test("the composer reports a stated finding, never as could not confirm", () => {
  assert.match(COMPOSER_PROMPT, STATED_FINDING_RULE);
});

test("outside-call inventory matches local judge and widget retry contracts", () => {
  const lines = readFileSync(
    new URL("../../.github/OUTSIDE-CALLS.md", import.meta.url),
    "utf8"
  ).split("\n");
  const judge =
    lines.find((line) => line.startsWith("| `agent/lib/widget-judge.ts`")) ??
    "";
  assert.ok(judge.includes(`${JUDGE_TIMEOUT_MS / 1000}s per judge call`));
  assert.ok(judge.includes("three concurrent local processes"));
  assert.ok(judge.includes("local `claude -p --model opus`"));
  const proxy = lines.find((line) => line.startsWith("| CLI Proxy (`")) ?? "";
  assert.equal(proxy.includes("eval judge"), false);
  assert.ok(proxy.includes("one timeout retry"));
  assert.ok(proxy.includes("20s reply-scan reserve"));
  const selector =
    lines.find((line) =>
      line.startsWith("| `agent/lib/widget-next-action.ts`")
    ) ?? "";
  assert.ok(
    selector.includes(
      `${DESCRIPTION_CHARS.toLocaleString("en-US")} characters each`
    )
  );
});

test("an investigation in a workspace with a feature off is told the feature is off, not unreadable (ENG-20514)", () => {
  const helpCenter = {
    featuresOff: [
      {
        feature: "ai_website",
        pages: ["/docs/sites"],
        title: "AI Website Creator",
      },
    ],
    viewer: "signed.viewer.token",
  };
  const auth = widgetAuth({ ...scope, helpCenter });
  // Only the names reach the session, never the signed viewer or the pages.
  assert.equal(auth.attributes?.featuresOff, '["AI Website Creator"]');
  assert.equal(JSON.stringify(auth).includes("signed.viewer.token"), false);
  const text = widgetInstructions(auth);
  assert.match(text, FEATURE_OFF_NAMES);
  assert.match(text, FEATURE_OFF_NO_ASK);
  assert.match(text, FEATURE_OFF_NOT_GAP);
  assert.equal(
    widgetInstructions(widgetAuth(scope)).includes(
      "not turned on for this workspace"
    ),
    false
  );
  assert.equal(
    widgetInstructions(
      widgetAuth({ ...scope, helpCenter: { ...helpCenter, featuresOff: [] } })
    ).includes("not turned on for this workspace"),
    false
  );
});

test("a malformed featuresOff stamp fails the scope closed instead of throwing", () => {
  const auth = widgetAuth(scope);
  assert.equal(
    widgetContext({
      ...auth,
      attributes: { ...auth.attributes, featuresOff: "{bad" },
    }),
    null
  );
});

const EACH_RECORD_RULE =
  /asks for the records themselves[^.]*write each record the result returns as its own fact with its own date and amount/;
const RECORDS_AVAILABLE_RULE =
  /never write that the dates or amounts of records you were given are unavailable/;
const MORE_RECORDS_RULE = /when there are more than 20, how many more/;
const OWN_DATE_RULE =
  /Every amount keeps the date of its own record: never group amounts under one date unless every one of those records has that date/;

test("the investigator lists each record it was asked for, each amount on its own record's date", () => {
  // ENG-20500: "six grants totalling 38,000 … I don't have each grant's date and amount".
  // ENG-20483: "$1 and $90 on 2026-11-14" when the $1 invoice was paid on 18 Nov.
  const prompt = widgetInstructions(widgetAuth(scope));
  assert.match(prompt, EACH_RECORD_RULE);
  assert.match(prompt, RECORDS_AVAILABLE_RULE);
  assert.match(prompt, MORE_RECORDS_RULE);
  assert.match(prompt, OWN_DATE_RULE);
});

test("an endpoint feature that is off names the areas it closes", () => {
  const text = widgetInstructions(
    widgetAuth({
      ...scope,
      areasOff: ["website"],
      featuresOff: ["ai website creator"],
    })
  );
  assert.match(text, FEATURE_OFF_AREAS);
  assert.match(text, FEATURE_OFF_NOT_GAP);
});
