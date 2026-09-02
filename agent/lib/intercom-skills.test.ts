import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const productSkill = readFileSync(
  new URL("../skills/intercom-triage-investigate/SKILL.md", import.meta.url),
  "utf8"
);
const billingSkill = readFileSync(
  new URL("../skills/intercom-billing-triage/SKILL.md", import.meta.url),
  "utf8"
);
const productTools = readFileSync(
  new URL(
    "../skills/intercom-triage-investigate/references/tools.md",
    import.meta.url
  ),
  "utf8"
);
const billingTools = readFileSync(
  new URL(
    "../skills/intercom-billing-triage/references/tools.md",
    import.meta.url
  ),
  "utf8"
);

test("Intercom product skill uses global memory retrieval after the claim", () => {
  const claim = productSkill.indexOf("## Step 3: State the claim");
  const memory = productSkill.indexOf(
    "## Step 3A: Search investigation memory"
  );
  const identity = productSkill.indexOf(
    "## Step 4: Pin identity and check existing evidence"
  );

  assert.ok(claim >= 0);
  assert.ok(memory > claim);
  assert.ok(identity > memory);
  assert.ok(productSkill.includes("accepts no Linear project metadata"));
  for (const area of [
    "Cold Email",
    "Domains & Inboxes",
    "AI SDR",
    "CRM",
    "Website Builder",
    "Core Platform",
  ]) {
    assert.ok(productSkill.includes(area), area);
  }
  assert.ok(productSkill.includes("excludes the planned Acquisity Agent area"));
  assert.ok(productSkill.includes("returned per product area"));
});

test("Intercom product skill records ticketless verdicts and thread corrections", () => {
  for (const phrase of [
    "## Step 8: Record the case",
    "with or without a Linear issue",
    "`intercom:<conversation id>`",
    "no project id",
    "`primaryFeatureKey`",
    "### Corrections from the thread",
    "put your overturned conclusion in `ruledOut`",
  ]) {
    assert.ok(productSkill.includes(phrase), phrase);
  }
  assert.ok(!productSkill.includes("are not recorded in this scope"));
  assert.ok(productTools.includes("`slack:<channel id>/<thread ts>`"));
});

test("Intercom product skill creates engineering work only for a confirmed bug", () => {
  for (const phrase of [
    "There is no Linear issue at the start",
    "Do not create a placeholder issue",
    "do not manufacture engineering work",
    "For a confirmed Bug",
    "canonical conversation URL",
    "explicit mapped Linear project",
    "subscription behavior with no financial remedy",
    "Link the new report from the master",
    "do not copy customer-specific conversation details",
  ]) {
    assert.ok(productSkill.includes(phrase), phrase);
  }
});

test("Intercom billing skill preserves evidence order and human-only action", () => {
  const planetscale = billingSkill.indexOf("1. PlanetScale");
  const autumn = billingSkill.indexOf("2. Autumn");
  const stripe = billingSkill.indexOf("3. Stripe");

  assert.ok(planetscale >= 0);
  assert.ok(autumn > planetscale);
  assert.ok(stripe > autumn);
  for (const phrase of [
    "There is no Linear issue",
    "never issues, schedules, grants, or promises",
    "one Support/Financial ticket",
    "project Support",
    "canonical conversation URL",
    "Subscription and invoice are request subjects",
    "expected future subscription or one-off invoice",
    "read_autumn_billing",
    "read_stripe_billing",
    "shared app-scoped Connect credentials",
  ]) {
    assert.ok(billingSkill.includes(phrase), phrase);
  }
});

test("Intercom skills attach the source conversation to customer tickets", () => {
  const linkAttachment =
    '`links: [{ url: <canonical conversation URL>, title: "Intercom conversation" }]`';

  assert.ok(productSkill.includes(linkAttachment));
  assert.ok(productSkill.includes("never the shared root-cause master"));
  assert.ok(billingSkill.includes(linkAttachment));
});

test("Intercom skills close with a customer-ready reply and the identifier", () => {
  const wording = readFileSync(
    new URL("../skills/slack-wording/SKILL.md", import.meta.url),
    "utf8"
  );
  const closingReplySection = (skill: string, followingHeading: string) => {
    const start = skill.indexOf("## Step 9: Reply in Slack");
    const end = skill.indexOf(followingHeading, start);

    assert.ok(start >= 0, "Step 9");
    assert.ok(end > start, followingHeading);
    return skill.slice(start, end);
  };
  const productReply = closingReplySection(
    productSkill,
    "## Triage investigation document"
  );
  const billingReply = closingReplySection(
    billingSkill,
    "## Billing investigation document"
  );

  for (const skill of [productReply, billingReply]) {
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
      "One closing status reply after the investigation and any required Linear writes are complete."
    )
  );

  assert.ok(!productSkill.includes("Do not include Linear identifiers"));
  assert.ok(
    productSkill.includes("Do not include assignees, internal routing")
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

test("Intercom skills own their tool references", () => {
  assert.ok(
    productSkill.includes("[references/tools.md](references/tools.md)")
  );
  assert.ok(
    billingSkill.includes("[references/tools.md](references/tools.md)")
  );

  for (const phrase of [
    "## Intercom (`intercom__`)",
    "search_investigation_memory",
    "accepts no Linear project metadata",
    "known conversation id",
  ]) {
    assert.ok(productTools.includes(phrase), phrase);
  }

  for (const phrase of [
    "## Intercom (`intercom__`)",
    "`fetch`, `get_conversation`",
    "planetscale_execute_read_query",
    "## Autumn (root tool)",
    "`read_autumn_billing`",
    "## Stripe (root tool)",
    "`read_stripe_billing`",
    "`list_issue_labels`",
  ]) {
    assert.ok(billingTools.includes(phrase), phrase);
  }
});
