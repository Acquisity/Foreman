import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// prompts.ts reads LINEAR_CONNECTOR and PLANETSCALE_MCP_CONNECTOR at module
// load (both auth providers live in constants.ts).
process.env.LINEAR_CONNECTOR = "linear/foreman-agent";
process.env.PLANETSCALE_MCP_CONNECTOR =
  "planet-scale-read-only-foreman/acquisity-foreman-planet-scale";

const { FACTORY_PROMPT, GENERAL_PROMPT } = await import("./prompts.js");

const readSource = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const sources: Record<string, string> = {
  "billing skill": readSource("../skills/billing-triage/references/tools.md"),
  "critic skill": readSource(
    "../subagents/critic/skills/triage-critic/SKILL.md"
  ),
  "critic tools": readSource(
    "../subagents/critic/skills/triage-critic/references/tools.md"
  ),
  "factory prompt": FACTORY_PROMPT,
  "general prompt": GENERAL_PROMPT,
  "intercom billing skill": readSource(
    "../skills/intercom-billing-triage/references/tools.md"
  ),
  "intercom triage skill": readSource(
    "../skills/intercom-triage-investigate/references/tools.md"
  ),
  "sla skill": readSource("../skills/sla-investigation/SKILL.md"),
  "triage tools": readSource(
    "../skills/triage-investigate/references/tools.md"
  ),
};

const SENTENCE_END = /(?<=[.!?])\s+/u;

// The only sanctioned negative mention, pinned in full: the critic's root
// tools are always present, so it must never search for them. Pin every
// sanctioned sentence in full so an unscoped instruction cannot pass merely
// by sharing a sentence with the required wording.
const CRITIC_PROHIBITION_SENTENCE =
  "`planetscale_execute_read_query`, the Instantly and billing reads, `search_investigation_memory`, and `read_image` are root tools that are always present; call them directly and never wait for `connection_search` to list them.";
const SCOPED_INSTRUCTION_SENTENCES = new Set([
  "Always call `connection_search` with the `connection` argument naming one connection; searching without it queries every connection at once.",
  "Connection tools are called as `<connection>__<tool>`; use `connection_search` with the `connection` argument naming one connection to discover what it exposes before calling one.",
  "Find them first with the built-in `connection_search`, called with the `connection` argument naming one connection; a connection's tools are discovered, not standing.",
  "Use the built-in `connection_search` with the `connection` argument naming one connection to discover what it actually exposes; never search without it, because that queries every connection at once.",
]);

const sentencesMentioningConnectionSearch = (source: string) =>
  source
    .split(SENTENCE_END)
    .filter((sentence) => sentence.includes("connection_search"));

// P2.2: discovery scopes to one connection. An unscoped connection_search
// queries every connection at once, which resolves authorization for all of
// them in one shot. Every authored mention must require the `connection`
// argument; every allowed instruction and the critic skill's single
// prohibition are matched by exact full-sentence equality.
test("every authored connection_search instruction names one connection", () => {
  assert.deepEqual(
    sentencesMentioningConnectionSearch(sources["critic skill"]),
    [CRITIC_PROHIBITION_SENTENCE],
    "the critic skill carries exactly the one pinned prohibition sentence"
  );
  for (const [name, source] of Object.entries(sources)) {
    if (name === "critic skill") {
      continue;
    }
    const sentences = sentencesMentioningConnectionSearch(source);
    assert.ok(sentences.length > 0, `${name} never mentions connection_search`);
    for (const sentence of sentences) {
      assert.ok(
        SCOPED_INSTRUCTION_SENTENCES.has(sentence),
        `${name} has an unscoped connection_search instruction: ${sentence}`
      );
    }
  }
});

test("both root prompts carry the scoped-discovery rule", () => {
  for (const prompt of [GENERAL_PROMPT, FACTORY_PROMPT]) {
    assert.ok(
      prompt.includes(
        "Always call `connection_search` with the `connection` argument naming one connection"
      )
    );
  }
});
