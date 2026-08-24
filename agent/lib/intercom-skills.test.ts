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

test("Intercom product skill searches project-free memory after the claim", () => {
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
  assert.ok(productSkill.includes("omit `linearProjectId`"));
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

test("Intercom product skill creates engineering work only for a confirmed bug", () => {
  for (const phrase of [
    "There is no Linear issue at the start",
    "Do not create a placeholder issue",
    "do not manufacture engineering work",
    "For a confirmed Bug",
    "canonical conversation URL",
    "explicit mapped Linear project",
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
  ]) {
    assert.ok(billingSkill.includes(phrase), phrase);
  }
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
    "omit `linearProjectId`",
  ]) {
    assert.ok(productTools.includes(phrase), phrase);
  }

  for (const phrase of [
    "## Intercom (`intercom__`)",
    "`fetch`, `get_conversation`",
    "planetscale_execute_read_query",
    "## Autumn (`autumn__`)",
    "## Stripe (`stripe__`)",
  ]) {
    assert.ok(billingTools.includes(phrase), phrase);
  }
});
