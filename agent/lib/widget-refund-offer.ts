// The chat moves no money, so a reply that asks whether the customer wants a
// refund, or offers to make one, is answered by nobody (ENG-20615: "Also, do
// you want the 9 missing inboxes refunded?"). The gate recomposes such a reply
// once with NO_REFUND_OFFER_CORRECTION and then deletes any such sentence left.
// Stating a finding ("Our team will refund what we couldn't set up", "your
// order was refunded", "I can't confirm the refund reached your card") is kept.

// A sentence's text: a decimal point inside an amount ($9.99) doesn't end it.
const S = String.raw`(?:[^.!?\n]|\.(?=\d))`;
// "refund" itself, or a verb that sets one going ("request a refund").
const ACT = String.raw`(?:refund\b|(?:request|process|issue|arrange|start|get)\b${S}{0,40}?\brefund)`;
const OFFER = [
  // Asking whether they want one.
  String.raw`\b(?:do|would|did) you (?:still )?(?:want|like|prefer)\b${S}{0,80}?\brefund`,
  String.raw`\b(?:tell me|let me know|confirm)\b${S}{0,40}?\b(?:whether|if) you(?:'|’)?d? (?:still )?(?:want|like)\b${S}{0,80}?\brefund`,
  // Offering to make one.
  String.raw`\b(?:shall|should|can|could|may) I (?:go ahead and )?${ACT}`,
  String.raw`\bI(?:'|’)ll (?:go ahead and )?(?:also )?${ACT}`,
  String.raw`\bI (?:can|could|will) (?:go ahead and )?(?:also )?${ACT}`,
].join("|");
const REFUND_OFFER = new RegExp(`${S}*(?:${OFFER})${S}*[.!?]?`, "giu");

export const withoutRefundOffers = (text: string) =>
  text
    .replace(REFUND_OFFER, "")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();

export const NO_REFUND_OFFER_CORRECTION =
  "You cannot refund, credit or move money, and nobody acts on a customer's answer here. Rewrite the reply without asking whether the customer wants a refund and without offering one. When the findings say the team will refund something, say that as the finding it is and that they don't need to do anything.";
