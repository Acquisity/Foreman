import assert from "node:assert/strict";
import { test } from "node:test";
import { ruledTicket } from "./widget-ticket-rules.js";

const json = (value: object) => JSON.stringify({ type: "json", value });

test("ticket rules inspect only customer messages for a billing dispute", () => {
  const billing = {
    result: json({
      sections: { inboxErrorCharges: { identifiesCharge: true } },
      status: "ok",
    }),
    tool: "widget_billing",
  };
  const supportOnly =
    "LATEST CUSTOMER MESSAGE (the one to work on):\nWhat plan am I on?\n\nEARLIER TURNS (context only):\nCustomer: My inbox needs checking.\nSupport: You can request a refund.\nSend us a dispute.";
  assert.equal(ruledTicket(supportOnly, [billing]), null);
  // An earlier turn's refund ask does not force another ticket on a follow-up.
  assert.equal(
    ruledTicket(
      supportOnly +
        "\nCustomer: Please refund those charges.\nI was billed while the inboxes were broken.",
      [billing]
    ),
    null
  );
  assert.equal(
    ruledTicket(
      "LATEST CUSTOMER MESSAGE (the one to work on):\nPlease refund those charges.\n\nEARLIER TURNS (context only):\nSupport: Which inboxes?",
      [billing]
    ),
    "billing"
  );
});

test("ticket rules ignore provider metadata flags and flags on other tools", () => {
  assert.equal(
    ruledTicket("What plan am I on?", [
      {
        result: JSON.stringify({
          autumn: { data: { metadata: { platformFault: true } } },
        }),
        tool: "widget_billing",
      },
    ]),
    null
  );
  assert.equal(
    ruledTicket("Refund please", [
      {
        result: json({
          sections: { inboxErrorCharges: { identifiesCharge: true } },
        }),
        tool: "widget_inboxes",
      },
    ]),
    null
  );
  assert.equal(
    ruledTicket("Refund please", [
      {
        result: JSON.stringify({
          autumn: { data: { identifiesCharge: true } },
        }),
        tool: "widget_billing",
      },
    ]),
    null
  );
});

// The endpoint tools mark the same readings in their sections (ENG-20547,
// ENG-20548), so a switched area keeps its ticket.
test("a refund ask files the billing ticket from the billing endpoint's inboxErrorCharges section", () => {
  const billing = (inboxErrorCharges: object | null) => ({
    result: json({
      sections: { inboxErrorCharges },
      status: "ok",
      unavailable: [],
    }),
    tool: "widget_billing",
  });
  assert.equal(
    ruledTicket("I want a refund.", [billing({ identifiesCharge: true })]),
    "billing"
  );
  assert.equal(
    ruledTicket("I want a refund.", [billing({ identifiesCharge: false })]),
    null
  );
  assert.equal(ruledTicket("I want a refund.", [billing(null)]), null);
  assert.equal(
    ruledTicket("What plan am I on?", [billing({ identifiesCharge: true })]),
    null
  );
  // The field counts only inside its section, as the endpoint returns it.
  assert.equal(
    ruledTicket("I want a refund.", [
      {
        result: json({ identifiesCharge: true, status: "ok" }),
        tool: "widget_billing",
      },
    ]),
    null
  );
});

test("follow-ups sent before their delay file the fault ticket from the campaigns endpoint's earlyFollowUps section", () => {
  const campaigns = (earlyFollowUps: object | null) => ({
    result: json({
      sections: { earlyFollowUps },
      status: "ok",
      unavailable: [],
    }),
    tool: "widget_campaigns",
  });
  const question = "All follow-ups went out 3 hours after the first email.";
  assert.equal(
    ruledTicket(question, [campaigns({ platformFault: true })]),
    "fault"
  );
  assert.equal(
    ruledTicket(question, [campaigns({ platformFault: false })]),
    null
  );
  // No campaign chosen: the section is null.
  assert.equal(ruledTicket(question, [campaigns(null)]), null);
  // Another endpoint's section of the same name is not the campaigns reading.
  assert.equal(
    ruledTicket(question, [
      {
        result: json({ sections: { earlyFollowUps: { platformFault: true } } }),
        tool: "widget_inboxes",
      },
    ]),
    null
  );
});

test("the old tools' readings still file while their areas are held", () => {
  assert.equal(
    ruledTicket("All follow-ups went out 3 hours after the first email.", [
      {
        result: json({
          campaigns: [
            { diagnostics: { earlyFollowUps: { platformFault: true } } },
          ],
        }),
        tool: "widget_outreach_health",
      },
    ]),
    "fault"
  );
});
