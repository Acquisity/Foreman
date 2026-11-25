import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { type GateDeps, gate } from "./widget-egress.js";
import type { WidgetFindings } from "./widget-findings.js";
import { withoutRefundOffers } from "./widget-refund-offer.js";

const CORRECTION = /cannot refund, credit or move money/u;
const orderId = "4ca90c58-0000-4000-8000-000000000000";
// The orders read as ENG-20615 saw it: a finished order parked with a refund as
// its next step, and no refund recorded.
const ordersFindings: WidgetFindings = {
  confidence: "high",
  facts: [
    {
      claim:
        "Your 5 October order finished with 27 of 36 inboxes set up. Its next step is that our team refunds what couldn't be set up, and no refund is recorded yet.",
      entityIds: [orderId],
      evidence: {
        ref: "attention.nextStep:refund_unfinished",
        tool: "widget_orders",
      },
    },
  ],
  needsHuman: false,
  recommendation:
    "Our team will refund the 9 inboxes that couldn't be set up; you don't need to do anything.",
  report: "Order parked with refund_unfinished and no refund recorded.",
};
const question =
  "Did I get refunded for my domain orders? Is anything still waiting on a refund?";

const gateDeps = (replies: string[]) => {
  const corrections: (string | undefined)[] = [];
  const deps: GateDeps = {
    compose: (input) => {
      corrections.push((input as { correction?: string }).correction);
      return Promise.resolve(
        replies[Math.min(corrections.length, replies.length) - 1]
      );
    },
    judge: () => Promise.resolve({ decision: "allow", reason: "in scope" }),
    resolve: () =>
      Promise.resolve({
        domains: new Set<string>(),
        emails: new Set<string>(),
        slugs: new Set<string>(),
        uuids: new Set([orderId]),
      }),
  };
  return { corrections, deps };
};

test("asking whether the customer wants a refund, or offering one, is caught, decimal amounts included", () => {
  for (const offer of [
    "Also, do you want the 9 missing inboxes refunded?",
    "Tell me whether you want the 9 unfinished inboxes refunded.",
    "Would you like the $9.99 refunded?",
    "I can refund $9.99 today.",
    "I'll go ahead and request a refund for the 9 inboxes.",
    "Shall I refund the unfinished inboxes?",
    "Let me know if you'd like a refund for them.",
  ]) {
    assert.equal(
      withoutRefundOffers(`Your order finished. ${offer}`),
      "Your order finished.",
      offer
    );
  }
});

test("stating what happened or what the team will do is kept", () => {
  for (const kept of [
    "Our team will refund what we couldn't set up, so you don't need to do anything.",
    "The three orders from 2 October were refunded to your card.",
    "I can confirm your order was refunded.",
    "I can't confirm that the $9.99 refund has reached your card.",
    "Refunds usually take five to ten days to reach your bank.",
  ]) {
    assert.equal(withoutRefundOffers(kept), kept, kept);
  }
});

test("an orders reply asking about a refund is recomposed, and one still offering loses that sentence (ENG-20615)", async () => {
  const offer =
    "Your 5 October order finished with 27 of 36 inboxes. Also, do you want the 9 missing inboxes refunded?";
  const corrected =
    "Your 5 October order finished with 27 of 36 inboxes. Our team will refund the 9 that couldn't be set up, so you don't need to do anything.";
  const fixed = gateDeps([offer, corrected]);
  const answer = await gate(scope, question, ordersFindings, fixed.deps);
  assert.equal(answer.message, corrected);
  assert.match(fixed.corrections[1] ?? "", CORRECTION);

  const stubborn = gateDeps([
    "Your 5 October order finished with 27 of 36 inboxes. Tell me whether you want the 9 unfinished inboxes refunded.",
  ]);
  const trimmed = await gate(scope, question, ordersFindings, stubborn.deps);
  assert.equal(
    trimmed.message,
    "Your 5 October order finished with 27 of 36 inboxes."
  );
});

test("a reply repaired for a ticket nobody filed is still checked for a refund offer", async () => {
  const { corrections, deps } = gateDeps([
    "I've passed this to the billing team. Do you want the missing inboxes refunded?",
    "Your order finished with 27 of 36 inboxes. Do you want the missing inboxes refunded?",
    "Your order finished with 27 of 36 inboxes. Our team will refund the rest.",
  ]);
  const answer = await gate(scope, question, ordersFindings, deps);
  assert.equal(
    answer.message,
    "Your order finished with 27 of 36 inboxes. Our team will refund the rest."
  );
  assert.equal(corrections.length, 3);
  assert.match(corrections[2] ?? "", CORRECTION);
});
