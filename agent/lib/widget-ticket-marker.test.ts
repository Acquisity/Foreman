import assert from "node:assert/strict";
import { test } from "node:test";
import { widgetScopeBlock } from "./executor/dispatch.js";
import { readAskFrom } from "./requester-reply.js";
import {
  isWidgetFiledDescription,
  WIDGET_SCOPE_NOTICE,
} from "./widget-ticket-marker.js";

const scope = {
  conversationId: "conv-1",
  organizationId: "org-1",
  organizationName: "Trivox AI",
  organizationSlug: "trivox",
} as Parameters<typeof widgetScopeBlock>[0];

const filed = `The customer cannot add inboxes.\n\n${widgetScopeBlock(scope)}`;

test("a ticket ending in the widget's verified scope block is widget-filed", () => {
  assert.equal(isWidgetFiledDescription(filed), true);
  assert.equal(isWidgetFiledDescription(`${filed}\n`), true);
  assert.equal(isWidgetFiledDescription(widgetScopeBlock(scope)), true);
});

test("the description Linear returns, with its bullets rewritten, still counts", () => {
  const stored = filed.replaceAll("\n- ", "\n* ");
  assert.notEqual(stored, filed);
  assert.equal(isWidgetFiledDescription(stored), true);
  assert.equal(
    isWidgetFiledDescription(
      stored.replace("Support conversation", "Intercom conversation")
    ),
    true
  );
});

test("an ordinary ticket, a quoted notice or a block with text after it is not", () => {
  assert.equal(isWidgetFiledDescription(null), false);
  assert.equal(
    isWidgetFiledDescription("The customer cannot add inboxes."),
    false
  );
  assert.equal(isWidgetFiledDescription(WIDGET_SCOPE_NOTICE), false);
  assert.equal(
    isWidgetFiledDescription(`Customer wrote: ${WIDGET_SCOPE_NOTICE}`),
    false
  );
  assert.equal(
    isWidgetFiledDescription(`${filed}\n\nPlease look at this today.`),
    false
  );
  assert.equal(
    isWidgetFiledDescription(
      `${filed.replace("- Organization ID: org-1\n", "")}`
    ),
    false
  );
});

const linearReturning = (
  description: string | null,
  attachments: { title: string; url: string }[] = []
) => ({
  fetch: (async () =>
    Response.json({
      data: { issue: { attachments: { nodes: attachments }, description } },
    })) as typeof fetch,
});

const credentials = { accessToken: "token" };
const thread = (channel: string) =>
  `https://fegrowthpartner.slack.com/archives/${channel}/p1791000000000100`;

test("the intake read marks widget-filed, support-conversation and migration-form tickets as triage intake", async () => {
  const cases: [
    string,
    Awaited<ReturnType<typeof readAskFrom>>["triageIntake"],
    string | null,
    { title: string; url: string }[],
  ][] = [
    ["widget-filed", true, filed, []],
    [
      "CRM form",
      true,
      "A report",
      [{ title: "Ask from Dana Lee", url: thread("C0C8XP8HAFL") }],
    ],
    [
      "developer channel",
      false,
      "A report",
      [{ title: "Ask from Dana Lee", url: thread("C0BLFDUN6Q7") }],
    ],
    ["plain ticket", false, "A report", []],
  ];
  const reads = await Promise.all(
    cases.map(([, , description, attachments]) =>
      readAskFrom(
        "issue-1",
        credentials,
        linearReturning(description, attachments)
      )
    )
  );
  cases.forEach(([name, expected], index) => {
    assert.equal(reads[index].triageIntake, expected, name);
  });
});
