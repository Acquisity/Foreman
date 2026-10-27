import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isStripeDisputeAlert,
  isStripeDisputeApprovalText,
  renderStripeDisputeAlert,
  STRIPE_DISPUTE_ALERTS_APP,
  STRIPE_DISPUTES_CHANNEL,
  stripeDisputeSessionAuth,
} from "./stripe-dispute-trigger.js";
import {
  canUseInvestigationMemory,
  isIntakeOnly,
  isQuestionsOnly,
  isStripeDisputeSession,
  isTrusted,
  isUnattended,
  stripeDisputeIdOf,
} from "./trust.js";

/** The shape Acquisity's alert arrives in, posted as Dispute Alerts with a Foreman tag. */
const alertEvent = (): Record<string, unknown> => ({
  app_id: STRIPE_DISPUTE_ALERTS_APP,
  blocks: [
    {
      text: {
        text: ":rotating_light:  Stripe dispute opened",
        type: "plain_text",
      },
      type: "header",
    },
    {
      fields: [
        { text: "*Amount*\n$185.00", type: "mrkdwn" },
        { text: "*Reason*\nfraudulent", type: "mrkdwn" },
      ],
      text: { text: "Dispute opened by Eric Mead.", type: "mrkdwn" },
      type: "section",
    },
    {
      elements: [
        {
          text: "<https://dashboard.stripe.com/disputes/du_1AbCdEf|Open in Stripe>",
          type: "mrkdwn",
        },
      ],
      type: "context",
    },
  ],
  bot_id: "B0BQA35JD62",
  channel: STRIPE_DISPUTES_CHANNEL,
  subtype: "bot_message",
  text: "<@U0BQ5QMHM7D> Dispute opened by Eric Mead. Nothing has been cancelled automatically; review the checklist.",
  ts: "1761400000.000100",
  type: "message",
  user: "U0BQ5QMHM7D",
});

describe("stripe dispute trigger", () => {
  it("accepts a top-level Dispute Alerts post, as a message or its mention", () => {
    assert.ok(isStripeDisputeAlert(STRIPE_DISPUTES_CHANNEL, alertEvent()));
    const { subtype: _subtype, ...plain } = alertEvent();
    assert.ok(isStripeDisputeAlert(STRIPE_DISPUTES_CHANNEL, plain));
    assert.ok(
      isStripeDisputeAlert(STRIPE_DISPUTES_CHANNEL, {
        ...plain,
        type: "app_mention",
      })
    );
    assert.ok(
      isStripeDisputeAlert(STRIPE_DISPUTES_CHANNEL, {
        ...alertEvent(),
        thread_ts: "1761400000.000100",
      })
    );
  });

  it("rejects thread replies, other channels, other apps, and edits", () => {
    const cases: [string, unknown, Record<string, unknown>][] = [
      [
        "thread reply",
        STRIPE_DISPUTES_CHANNEL,
        { ...alertEvent(), thread_ts: "1761300000.000100" },
      ],
      ["other channel", "C0DEV", alertEvent()],
      [
        "Foreman's own app",
        STRIPE_DISPUTES_CHANNEL,
        { ...alertEvent(), app_id: "A0BQA371MBQ" },
      ],
      [
        "missing app id",
        STRIPE_DISPUTES_CHANNEL,
        { ...alertEvent(), app_id: undefined },
      ],
      [
        "message_changed",
        STRIPE_DISPUTES_CHANNEL,
        { ...alertEvent(), subtype: "message_changed" },
      ],
      [
        "message_deleted",
        STRIPE_DISPUTES_CHANNEL,
        { ...alertEvent(), subtype: "message_deleted" },
      ],
      [
        "reaction",
        STRIPE_DISPUTES_CHANNEL,
        { ...alertEvent(), type: "reaction_added" },
      ],
      [
        "non-alert post",
        STRIPE_DISPUTES_CHANNEL,
        {
          ...alertEvent(),
          blocks: [
            {
              text: { text: "Evidence staged", type: "plain_text" },
              type: "header",
            },
          ],
          text: "Evidence staged for du_1AbCdEf",
        },
      ],
      [
        "plain text only",
        STRIPE_DISPUTES_CHANNEL,
        { ...alertEvent(), blocks: undefined },
      ],
    ];
    for (const [name, channel, message] of cases) {
      assert.equal(isStripeDisputeAlert(channel, message), false, name);
    }
  });

  it("checks the channel before anything else", () => {
    const touched: string[] = [];
    const watched = new Proxy(alertEvent(), {
      get(target, key) {
        touched.push(String(key));
        return Reflect.get(target, key);
      },
    });
    assert.equal(isStripeDisputeAlert("C0DEV", watched), false);
    assert.deepEqual(touched, []);
  });

  it("renders the alert with the dispute id first, from the link", () => {
    const text = renderStripeDisputeAlert(alertEvent());
    assert.ok(text.startsWith("Dispute id: du_1AbCdEf\n"));
    assert.ok(text.includes("Dispute opened by Eric Mead."));
    assert.ok(text.includes("$185.00"));
    assert.ok(text.includes("dashboard.stripe.com/disputes/du_1AbCdEf"));
  });

  it("keeps the id when the alert text is long enough to be cut", () => {
    const long = {
      ...alertEvent(),
      text: "x".repeat(50_000),
    };
    const text = renderStripeDisputeAlert(long);
    assert.ok(text.startsWith("Dispute id: du_1AbCdEf\n"));
    assert.ok(text.length < 8000);
  });

  it("says so when no dispute id is in the alert", () => {
    const text = renderStripeDisputeAlert({ text: "Stripe dispute opened" });
    assert.ok(text.startsWith("Dispute id: not found in the alert"));
  });

  it("stamps the automatic session unattended and trusted, nothing more", () => {
    const auth = stripeDisputeSessionAuth({
      disputeId: "du_1AbCdEf",
      teamId: "T123",
      threadTs: "1761400000.000100",
    });
    assert.ok(isStripeDisputeSession(auth));
    assert.ok(isUnattended(auth));
    assert.ok(isTrusted(auth));
    assert.equal(isIntakeOnly(auth), false);
    assert.equal(isQuestionsOnly(auth), false);
    assert.equal(canUseInvestigationMemory(auth), false);
    assert.notEqual(auth.principalType, "user");
    assert.equal(auth.attributes.channel_id, STRIPE_DISPUTES_CHANNEL);
    assert.equal(stripeDisputeIdOf(auth), "du_1AbCdEf");
  });

  it("reads only a plain approve as an approval", () => {
    for (const text of [
      "approve",
      "<@U0BQ5QMHM7D> approve",
      "<@U0BQ5QMHM7D|foreman> Approve!",
      "  APPROVE. ",
    ]) {
      assert.ok(isStripeDisputeApprovalText(text), text);
    }
    for (const text of [
      "<@U0BQ5QMHM7D> should we approve?",
      "approve but drop the receipt",
      "don't approve",
      "approved",
      "",
    ]) {
      assert.equal(isStripeDisputeApprovalText(text), false, text);
    }
  });
});
