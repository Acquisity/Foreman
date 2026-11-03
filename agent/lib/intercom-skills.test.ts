import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const productSkill = readFileSync(
  new URL("../skills/triage/SKILL.md", import.meta.url),
  "utf8"
);
const intercomSource = productSkill.slice(
  productSkill.indexOf("## Intercom source"),
  productSkill.indexOf("## Examples")
);
const billingSkill = readFileSync(
  new URL("../skills/billing-triage/SKILL.md", import.meta.url),
  "utf8"
);
const billingIntercom = billingSkill.slice(
  billingSkill.indexOf("## Intercom source")
);
const productTools = readFileSync(
  new URL("../skills/triage/references/tools.md", import.meta.url),
  "utf8"
);
test("an Intercom claim searches the same global memory as a ticket", () => {
  const lanes = readFileSync(
    new URL("../skills/triage/references/lanes.md", import.meta.url),
    "utf8"
  );
  assert.ok(lanes.includes("accepts no Linear project id"));
  assert.ok(lanes.includes("Intercom-native claims with no ticket at all"));
  for (const area of [
    "Cold Email",
    "Domains & Inboxes",
    "AI SDR",
    "CRM",
    "Website Builder",
    "Core Platform",
  ]) {
    assert.ok(lanes.includes(area), area);
  }
  assert.ok(lanes.includes("excludes the planned Acquisity Agent area"));
  assert.ok(lanes.includes("returned per product area"));
});

test("an Intercom source records ticketless verdicts and thread corrections", () => {
  for (const phrase of [
    "`intercom:<conversation id>`",
    "no project id",
    "`primaryFeatureKey`",
  ]) {
    assert.ok(intercomSource.includes(phrase), phrase);
  }
  assert.ok(
    productSkill.includes("puts your overturned conclusion in `ruledOut`")
  );
});

test("an Intercom source creates engineering work only for a confirmed bug or feature request", () => {
  for (const phrase of [
    "there is no Linear issue at the start",
    "Never create a placeholder issue",
    "do not manufacture engineering work",
    "canonical conversation URL",
    "A Support/Product follow-up is filed only when a person must act",
    '`state: "Todo"`, the `Support` project, Aaron Fraga',
  ]) {
    assert.ok(intercomSource.includes(phrase), phrase);
  }
  assert.equal(intercomSource.includes("STAGE 4 COMPLETE"), false);
});

test("the Intercom billing source keeps the evidence order and human-only action", () => {
  const planetscale = billingSkill.indexOf("1. PlanetScale, first and always");
  const autumn = billingSkill.indexOf("2. Autumn, second");
  const stripe = billingSkill.indexOf("3. Stripe, last");

  assert.ok(planetscale >= 0);
  assert.ok(autumn > planetscale);
  assert.ok(stripe > autumn);
  assert.ok(billingIntercom.includes("The procedure above applies"));
  for (const phrase of [
    "there is no Linear issue",
    "never issues, schedules, grants, or promises",
    "one Support/Financial ticket",
    "project Support",
    "canonical conversation URL",
    "Subscription and invoice are request subjects",
    "expected future subscription or one-off invoice",
    "shared app-scoped Executor connection",
    "An unattended scheduled run asks nobody",
    "name the missing workspace or billing email as what would reopen it",
  ]) {
    assert.ok(billingIntercom.includes(phrase), phrase);
  }
  // Partner governance comes from the code-computed flag on every source.
  assert.ok(
    billingSkill.includes("Route on `partnerGoverned`, which the code computes")
  );
  assert.equal(billingSkill.includes("partner_id"), false);
});

test("Intercom skills attach the source conversation to customer tickets", () => {
  const linkAttachment =
    '`links: [{ url: <canonical conversation URL>, title: "Intercom conversation" }]`';

  assert.ok(intercomSource.includes(linkAttachment));
  assert.ok(billingIntercom.includes(linkAttachment));
});

test("ticket-link follow-ups are answered from the general reply rule", async () => {
  process.env.LINEAR_CONNECTOR ??= "linear/foreman-agent";
  const { GENERAL_PROMPT } = await import("./prompts.js");
  assert.ok(
    GENERAL_PROMPT.includes(
      "For a follow-up asking for an existing ticket link, use the ticket references already in context and return the requested link without restarting the investigation."
    )
  );
});

test("Intercom skills close with a customer-ready reply and the identifier", () => {
  const wording = readFileSync(
    new URL("../skills/slack-wording/SKILL.md", import.meta.url),
    "utf8"
  );
  const closingReplySection = (skill: string, followingHeading: string) => {
    const start = skill.indexOf("### Intercom reply in Slack");
    const end = skill.indexOf(followingHeading, start);

    assert.ok(start >= 0, "Intercom reply");
    return end > start ? skill.slice(start, end) : skill.slice(start);
  };
  const billingReply = closingReplySection(billingSkill, "\n## ");

  for (const skill of [billingReply]) {
    for (const phrase of [
      'a short block headed "Reply you can send"',
      "no internal names and no system names",
      "Omit it when the reply asks the requester for missing information",
      'when the requester wrote "do not reply to the customer" or anything equivalent',
      "when the verdict routes to engineering with no customer-facing answer yet",
      "end the reply with that bare identifier alone on the last line",
      "never a URL",
      "when it created none, say nothing about a ticket",
    ]) {
      assert.ok(skill.includes(phrase), phrase);
    }

    const replyBlock = skill.indexOf(
      'a short block headed "Reply you can send"'
    );
    const missingInformation = skill.indexOf(
      "Omit it when the reply asks the requester for missing information"
    );
    const noCustomerReply = skill.indexOf(
      'when the requester wrote "do not reply to the customer" or anything equivalent'
    );
    const engineeringRoute = skill.indexOf(
      "when the verdict routes to engineering with no customer-facing answer yet"
    );
    const identifier = skill.indexOf(
      "end the reply with that bare identifier alone on the last line"
    );
    const noTicket = skill.indexOf(
      "when it created none, say nothing about a ticket"
    );

    assert.ok(replyBlock >= 0);
    assert.ok(missingInformation > replyBlock);
    assert.ok(noCustomerReply > missingInformation);
    assert.ok(engineeringRoute > noCustomerReply);
    assert.ok(identifier > engineeringRoute);
    assert.ok(noTicket > identifier);
  }

  assert.ok(
    billingReply.includes(
      "The thread gets one closing status reply after the investigation and any required Linear writes are complete."
    )
  );

  assert.ok(!intercomSource.includes("Do not include Linear identifiers"));
  assert.ok(
    intercomSource.includes(
      "Leave out assignees, routing, code paths, SQL, raw logs, system names, customer identifiers and memory status"
    )
  );
  assert.ok(!billingSkill.includes("ticket identifiers"));
  assert.ok(
    billingSkill.includes(
      "Never mention Stripe, Autumn, internal system readouts, assignee names"
    )
  );

  const linearProhibition = wording.indexOf(
    "- Linear issue IDs, ticket numbers, statuses"
  );
  const intercomException = wording.indexOf(
    "The one exception to Linear issue IDs and raw IDs: the final reply of an Intercom investigation ends with the bare ticket identifier on its own line"
  );

  assert.ok(linearProhibition >= 0);
  assert.ok(intercomException > linearProhibition);
  assert.ok(
    wording.includes("- Internal dev names, assignees, project owners")
  );
});

test("the Intercom sources share the one triage tool catalog", () => {
  assert.ok(
    productSkill.includes("[references/tools.md](references/tools.md)")
  );
  assert.ok(
    billingSkill.includes(
      "[../triage/references/tools.md](../triage/references/tools.md)"
    )
  );
  for (const restated of ["## Master", "Overview", "roster"]) {
    assert.equal(productTools.includes(restated), false, restated);
  }
  for (const phrase of [
    "| Intercom | Executor: intercom |",
    "`read_autumn_billing`",
    "`read_stripe_billing`",
    "`list_issue_labels`",
    "planetscale_execute_read_query",
  ]) {
    assert.ok(productTools.includes(phrase), phrase);
  }
});
