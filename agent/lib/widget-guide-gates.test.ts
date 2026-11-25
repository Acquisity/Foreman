import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OPT_IN_NOTE,
  pageIsOptIn,
  spellOutOptInGates,
} from "./widget-guide-gates.js";

const OPT_IN = new Set(["local_business_leads", "crm_payments"]);

test("an opt-in section gate keeps its condition on exactly its own text", () => {
  // Shaped like crm/payments.mdx at Acquisity 2e4352eedb8f (ENG-20607).
  const mdx = [
    "Templates only: your admin chose templates.",
    '<FeatureGate feature="crm_payments">',
    "### From a Call",
    "Send a payment link while you're on a call.",
    "</FeatureGate>",
    "Click a lead's status to see its history.",
  ].join("\n");
  assert.equal(
    spellOutOptInGates(mdx, OPT_IN),
    [
      "Templates only: your admin chose templates.",
      "",
      `Note: ${OPT_IN_NOTE}`,
      "### From a Call",
      "Send a payment link while you're on a call.",
      "(End of the part that is only on workspaces where it has been turned on.)",
      "",
      "Click a lead's status to see its history.",
    ].join("\n")
  );
});

test("a not gate says its text is for workspaces without the feature", () => {
  const out = spellOutOptInGates(
    '<FeatureGate feature="local_business_leads" not>Ask support to turn it on.</FeatureGate>',
    OPT_IN
  );
  assert.ok(
    out.includes("Note: Only on workspaces where it has not been turned on.")
  );
  assert.ok(!out.includes(OPT_IN_NOTE));
});

test("a gate on a feature that is on by default is left for the MDX strip", () => {
  const gate =
    '<FeatureGate feature="cold_email_agent">Open Campaigns.</FeatureGate>';
  assert.equal(spellOutOptInGates(gate, OPT_IN), gate);
});

test("a page is opt-in only when its front matter names an opt-in feature", () => {
  assert.equal(
    pageIsOptIn("title: Local\nfeatures: [local_business_leads]", OPT_IN),
    true
  );
  assert.equal(
    pageIsOptIn("title: Leads\nfeatures: [cold_email_agent]", OPT_IN),
    false
  );
  assert.equal(pageIsOptIn("title: Overview", OPT_IN), false);
});
