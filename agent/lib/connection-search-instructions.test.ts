import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

process.env.LINEAR_CONNECTOR = "linear/foreman-agent";

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

const REMOVED_CONNECTION_CALL =
  /\b(?:autumn|stripe|neon|instantly|axiom|intercom|inngest|jam|linear|lucent|modem|openrouter|planetscale|posthog|resend|sentry|vercel)__/u;

test("active instructions route company discovery through the session's Executor profile", () => {
  for (const [name, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, REMOVED_CONNECTION_CALL, name);
    if (name === "critic skill") {
      continue;
    }
    assert.ok(source.includes("connection_search"), name);
    assert.ok(source.includes("tools.search({ namespace, query })"), name);
    assert.ok(source.includes("tools.describe.tool({ path })"), name);
    assert.ok(source.includes("tools[path](input)"), name);
  }
});
test("root prompts keep authored helpers separate from provider discovery", () => {
  for (const prompt of [GENERAL_PROMPT, FACTORY_PROMPT]) {
    assert.ok(prompt.includes("bare names without discovery"));
    assert.ok(prompt.includes("never search every connection"));
    assert.ok(prompt.includes("Personal Supermemory"));
  }
});

test("all agent-facing Markdown avoids retired provider connection names", () => {
  const root = new URL("../", import.meta.url);
  for (const path of readdirSync(root, { recursive: true })) {
    if (typeof path === "string" && path.endsWith(".md")) {
      assert.doesNotMatch(
        readFileSync(new URL(path, root), "utf8"),
        REMOVED_CONNECTION_CALL,
        path
      );
    }
  }
});
