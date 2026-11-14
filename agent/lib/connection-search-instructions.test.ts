import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

process.env.LINEAR_CONNECTOR = "linear/foreman-agent";

const { GENERAL_PROMPT } = await import("./prompts.js");
const { EXECUTOR_DISCOVERY } = await import("./executor/instructions.js");

const readSource = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

const sources: Record<string, string> = {
  "critic skill": readSource(
    "../subagents/critic/skills/triage-critic/SKILL.md"
  ),
  "critic tools": readSource(
    "../subagents/critic/skills/triage-critic/references/tools.md"
  ),
  "general prompt": GENERAL_PROMPT,
  "sla skill": readSource("../skills/sla-investigation/SKILL.md"),
  "stripe disputes skill": readSource("../skills/stripe-disputes/SKILL.md"),
  "triage tools": readSource("../skills/triage/references/tools.md"),
};

const REMOVED_CONNECTION_CALL =
  /\b(?:autumn|stripe|neon|instantly|axiom|intercom|inngest|jam|linear|lucent|modem|openrouter|planetscale|posthog|raindrop|resend|sentry|vercel)__/u;

test("active instructions route company discovery through the shared Executor connection", () => {
  // The how-to lives once, in the discovery text every root and critic turn
  // carries; skills point at it instead of restating it.
  for (const rule of [
    "eve__search",
    "searches only",
    "eve__tool",
    "tools.search({ namespace, query })",
    "tools.search.describe({ paths: [path] })",
    "wrap each call in try/catch",
  ]) {
    assert.ok(EXECUTOR_DISCOVERY.includes(rule), rule);
    assert.ok(GENERAL_PROMPT.includes(rule), rule);
  }
  for (const [name, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, REMOVED_CONNECTION_CALL, name);
    if (name === "critic skill" || name === "general prompt") {
      continue;
    }
    assert.ok(
      source.includes("this session's Executor discovery instructions"),
      name
    );
    assert.equal(
      source.includes("tools.search({ namespace, query })"),
      false,
      name
    );
  }
});
test("root prompts keep authored helpers separate from provider discovery", () => {
  assert.ok(GENERAL_PROMPT.includes("bare names without discovery"));
  assert.ok(GENERAL_PROMPT.includes("never search every connection"));
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
