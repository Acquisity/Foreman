import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const NAME_PLACEHOLDER = /^Name \d+$/;
const EMAIL_PLACEHOLDER = /^person-\d+@domain-\d+\.example$/;
const QUESTION_PLACEHOLDER = /^Why is Name \d+ not sending\?$/;
const NOT_SAVED = /Case not saved/;
const PHONE_PLACEHOLDER = /^Phone \d+$/;

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

test("payload keys cannot exempt domains, and authored references survive absent fields", () => {
  const scrubbed = scrubCase(
    rawCase({
      caveat:
        "diagnostics.dailyMetrics covers the requested window; accounts.truncated and live.deployment.buildError are authored references",
      domain: "shop.com",
      shop: { com: 1 },
    }),
    scope
  );
  const output = scrubbed.case.cassette[0].output as {
    domain: string;
    caveat: string;
  };
  assert.equal(output.domain, "domain-1.example");
  assert.equal(
    output.caveat,
    "diagnostics.dailyMetrics covers the requested window; accounts.truncated and live.deployment.buildError are authored references"
  );
  serializeCase(scrubbed);
  output.domain = "shop.com";
  assert.throws(() => serializeCase(scrubbed), NOT_SAVED);
});

test("the original-value guard checks decoded strings and object keys without token boundaries", () => {
  const scrubbed = scrubCase(
    rawCase({}, "Northwind Growth_US is broken"),
    scope
  );
  assert.throws(() => serializeCase(scrubbed), NOT_SAVED);
  const quotedScope = { ...scope, organizationName: 'Northwind "Growth"' };
  const quoted = scrubCase(rawCase({}), quotedScope);
  quoted.case.question = 'Why is Northwind "Growth" broken?';
  assert.throws(() => serializeCase(quoted), NOT_SAVED);
  quoted.case.question = "Why is this broken?";
  quoted.case.cassette[0].output = { [quotedScope.organizationName]: 1 };
  assert.throws(() => serializeCase(quoted), NOT_SAVED);
});

test("short known names are replaced, and remaining short-name prose fails closed", () => {
  const scrubbed = scrubCase(
    rawCase({ name: "Li" }, "Why is this broken?"),
    scope
  );
  assert.deepEqual(scrubbed.case.cassette[0].output, { name: "Name 1" });
  serializeCase(scrubbed);
  scrubbed.case.question = "Li_US cannot sign in";
  assert.throws(() => serializeCase(scrubbed), NOT_SAVED);
});

test("recording JSON strings retain their type while names and phones are scrubbed", () => {
  const scrubbed = scrubCase(
    rawCase(
      {
        recording: JSON.stringify({
          nested: JSON.stringify([{ name: "Q1" }]),
          phone: "+1 415 555 0199",
          senderName: "Jane Doe",
        }),
      },
      "Why is this broken?"
    ),
    scope
  );
  const output = scrubbed.case.cassette[0].output as { recording: string };
  assert.equal(typeof output.recording, "string");
  const decoded = JSON.parse(output.recording);
  assert.match(decoded.senderName, NAME_PLACEHOLDER);
  assert.equal(decoded.phone, "Phone 1");
  assert.match(JSON.parse(decoded.nested)[0].name, NAME_PLACEHOLDER);
  assert.notEqual(JSON.parse(decoded.nested)[0].name, decoded.senderName);
  const text = serializeCase(scrubbed);
  assert.ok(!text.includes("Jane Doe"));
  assert.ok(!text.includes("555 0199"));
});

test("MIME-typed images and long base64 data are dropped, including in JSON strings", () => {
  const data = "A".repeat(128);
  const scrubbed = scrubCase(
    rawCase({
      bytes: data,
      data: "ok",
      nested: JSON.stringify({
        data,
        screenshot: { data, mimeType: "image/png" },
      }),
      screenshot: { data: "iVBORw0KGgo", mimeType: "image/png" },
      text: "ordinary text",
    }),
    scope
  );
  const text = serializeCase(scrubbed);
  assert.ok(!text.includes("iVBORw0KGgo"));
  assert.ok(!text.includes(data));
  assert.ok(text.includes("ordinary text"));
  assert.equal(
    (scrubbed.case.cassette[0].output as { data: string }).data,
    "ok"
  );
});

test("email local parts and domains are independently consistent", () => {
  const scrubbed = scrubCase(
    rawCase({ emails: ["a@x.com", "a@y.com", "b@x.com"] }),
    scope
  );
  assert.deepEqual(scrubbed.case.cassette[0].output, {
    emails: [
      "person-1@domain-1.example",
      "person-1@domain-2.example",
      "person-2@domain-1.example",
    ],
  });
  serializeCase(scrubbed);
});

test("the outside-call inventory documents the converter and both subprocess bounds", () => {
  const inventory = readFileSync(
    new URL("../../.github/OUTSIDE-CALLS.md", import.meta.url),
    "utf8"
  );
  const entry = inventory
    .split("\n")
    .find((line) => line.includes("scripts/widget-case-from-run.ts"));
  assert.ok(entry);
  assert.ok(entry.includes("180s per subprocess"));
  assert.ok(entry.includes("@workflow/cli@5.0.1 inspect"));
  assert.ok(entry.includes("Biome"));
});

test("a name too long to match inline is replaced as a whole field and fails closed elsewhere", () => {
  const long = `Spring ${"Promo ".repeat(60)}`.trim();
  const saved = JSON.parse(
    serializeCase(scrubCase(rawCase({ campaignName: long }), scope))
  ).cassette[0].output;
  assert.match(saved.campaignName, NAME_PLACEHOLDER);
  assert.throws(
    () =>
      serializeCase(
        scrubCase(
          rawCase({ campaignName: long }, `Why is ${long} late?`),
          scope
        )
      ),
    NOT_SAVED
  );
});

test("phone_number fields and numeric phones are replaced", () => {
  const saved = JSON.parse(
    serializeCase(
      scrubCase(
        rawCase({
          phone_number: "+1 415 555 0199",
          phoneNumber: 14_155_550_199,
        }),
        scope
      )
    )
  ).cassette[0].output;
  assert.match(saved.phone_number, PHONE_PLACEHOLDER);
  assert.match(saved.phoneNumber, PHONE_PLACEHOLDER);
});

test("data URIs with MIME parameters are dropped", () => {
  const saved = JSON.parse(
    serializeCase(
      scrubCase(
        rawCase({
          icon: "data:image/svg+xml;charset=utf-8;base64,PHN2Zz48L3N2Zz4=",
        }),
        scope
      )
    )
  ).cassette[0].output;
  assert.ok(!JSON.stringify(saved).includes("PHN2Zz"));
});

test("internal ticket refs and links are replaced", () => {
  const text = serializeCase(
    scrubCase(
      rawCase({
        ticket: "ENG-14665",
        url: "https://linear.app/acquisity/issue/ENG-14665/spring-promo-not-sending",
      }),
      scope
    )
  );
  assert.ok(!text.includes("ENG-14665"));
  assert.ok(!text.includes("spring-promo"));
});

test("an id joined to a domain with hyphens is replaced inside the composite", () => {
  const order = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const text = serializeCase(
    scrubCase(
      rawCase({
        orderSubscriptions: [{ domain: "sendmail-x.com", orderId: order }],
        subscriptions: [{ id: `${order}-sendmail-x.com-inboxes` }],
      }),
      scope
    )
  );
  assert.ok(!text.includes(order));
  assert.ok(!text.includes("sendmail-x"));
  assert.ok(text.includes(".example-inboxes"));
});

test("billing catalog names are product labels, not customer names", () => {
  const saved = JSON.parse(
    serializeCase(
      scrubCase(
        rawCase({
          balances: {
            domains: { feature: { id: "domains", name: "Domains" } },
            website_credit: {
              display: { primary_text: "500 Website Credits" },
              feature: { id: "website_credit", name: "Website Credit" },
            },
          },
          name: "Spring Promo",
        }),
        scope
      )
    )
  ).cassette[0].output;
  assert.equal(saved.balances.domains.feature.name, "Domains");
  assert.equal(saved.balances.website_credit.feature.name, "Website Credit");
  assert.match(saved.name, NAME_PLACEHOLDER);
});
