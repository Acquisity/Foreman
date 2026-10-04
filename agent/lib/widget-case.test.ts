import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext as fixture } from "./widget.fixture.js";
import {
  type RunScope,
  scrubCase,
  serializeCase,
  type WidgetCase,
} from "./widget-case.js";

const scope: RunScope = {
  conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  organizationName: "Northwind Growth",
  organizationSlug: "northwind-growth-x1Y2",
  userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const at = "2026-10-02T19:53:54.776Z";
const EMAIL_PLACEHOLDER = /^person-\d+@domain-\d+\.example$/;
const QUESTION_PLACEHOLDER = /^Why is Name \d+ not sending\?$/;
const NOT_SAVED = /Case not saved/;

const rawCase = (
  output: unknown,
  question = "Why is Spring Promo not sending?"
): WidgetCase => ({
  cassette: [
    {
      input: { campaignId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
      output,
      requestedAt: at,
      resultAt: at,
      status: "completed",
      tool: "widget_outreach_health",
    },
  ],
  expectations: {
    cause: null,
    claims: [],
    fileTicket: null,
    gateVerdict: null,
    lane: null,
    toolBudget: null,
  },
  question,
  scope: { role: "owner", workspace: scope.organizationSlug },
  source: { runId: "wrun_41M3Z2W85E0GVAF25PYS9Z5GAX", target: "production" },
  tags: {
    lane: null,
    role: "owner",
    safety: [],
    tools: ["widget_outreach_health"],
  },
});

const health = {
  campaigns: [
    {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      inboxes: [
        { email: "Jane@Acme-Mail.com" },
        { email: "bob@acme-mail.com" },
      ],
      name: "Spring Promo",
      workspace: scope.organizationName,
    },
  ],
  link: `https://app.acquisity.ai/dashboard/${scope.organizationSlug}/campaigns`,
  owner: { phone: "+1 415 555 0199", senderName: "Jane Doe" },
};

test("the same real email maps to one placeholder in both tool results", () => {
  const raw = rawCase(health);
  raw.cassette.push({
    ...raw.cassette[0],
    output: { mismatch: "jane@acme-mail.com is not on this campaign" },
    tool: "widget_inbox_health",
  });
  const scrubbed = scrubCase(raw, scope);
  const [first, second] = scrubbed.case.cassette;
  const { inboxes } = (first.output as typeof health).campaigns[0];
  assert.match(inboxes[0].email, EMAIL_PLACEHOLDER);
  assert.equal(
    (second.output as { mismatch: string }).mismatch,
    `${inboxes[0].email} is not on this campaign`
  );
  // Two addresses at one domain keep one placeholder domain.
  assert.equal(inboxes[0].email.split("@")[1], inboxes[1].email.split("@")[1]);
  assert.notEqual(inboxes[0].email, inboxes[1].email);
  const text = serializeCase(scrubbed);
  for (const real of [
    "acme-mail",
    "Jane Doe",
    "Spring Promo",
    "555 0199",
    "Northwind",
    "northwind-growth",
  ]) {
    assert.ok(!text.toLowerCase().includes(real.toLowerCase()), real);
  }
  assert.ok(text.includes(fixture.organizationSlug));
  assert.ok(text.includes(fixture.organizationName));
  assert.equal(scrubbed.case.scope.workspace, fixture.organizationSlug);
  assert.match(scrubbed.case.question, QUESTION_PLACEHOLDER);
});

test("scope ids map onto the fixture org", () => {
  const scrubbed = scrubCase(
    rawCase({ organizationId: scope.organizationId, userId: scope.userId }),
    scope
  );
  assert.deepEqual(scrubbed.case.cassette[0].output, {
    organizationId: fixture.organizationId,
    userId: fixture.userId,
  });
});

test("images and base64 payloads are dropped", () => {
  const scrubbed = scrubCase(
    rawCase({
      parts: [{ data: "iVBORw0KGgo", mediaType: "image/png", type: "file" }],
      shot: "data:image/png;base64,iVBORw0KGgo",
    }),
    scope
  );
  assert.ok(!JSON.stringify(scrubbed.case).includes("iVBORw0KGgo"));
});

test("a leftover real identifier fails the save", () => {
  const scrubbed = scrubCase(rawCase(health), scope);
  (scrubbed.case.cassette[0].output as Record<string, unknown>).note =
    "also cc ops@realcustomer.com";
  assert.throws(() => serializeCase(scrubbed), NOT_SAVED);
});

test("a leftover scope name fails the save", () => {
  const scrubbed = scrubCase(rawCase(health), scope);
  scrubbed.case.question = "What is wrong with Northwind Growth?";
  assert.throws(() => serializeCase(scrubbed), NOT_SAVED);
});
