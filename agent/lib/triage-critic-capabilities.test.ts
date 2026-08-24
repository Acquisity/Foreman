import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planetscale/test";
process.env.VERCEL_MCP_CONNECTOR ??= "vercel/test";
process.env.AUTUMN_MCP_CONNECTOR ??= "autumn/test";
process.env.STRIPE_MCP_CONNECTOR ??= "stripe/test";

const [
  { default: autumn },
  { AUTUMN_READ_TOOLS },
  { default: linear },
  { default: stripe },
  { STRIPE_READ_TOOLS },
  { default: vercel },
  { VERCEL_READ_TOOLS },
] = await Promise.all([
  import("../subagents/triage-critic/connections/autumn.js"),
  import("../connections/autumn.js"),
  import("../subagents/triage-critic/connections/linear.js"),
  import("../subagents/triage-critic/connections/stripe.js"),
  import("../connections/stripe.js"),
  import("../subagents/triage-critic/connections/vercel.js"),
  import("../connections/vercel.js"),
]);

const toolSource = (name: string): string =>
  readFileSync(
    new URL(`../subagents/triage-critic/tools/${name}.ts`, import.meta.url),
    "utf8"
  );

describe("triage-critic capabilities", () => {
  it("requires explicit review for every mounted connection and tool", () => {
    const filenames = (directory: string): string[] =>
      readdirSync(new URL(directory, import.meta.url))
        .filter((name) => name.endsWith(".ts"))
        .sort();
    assert.deepEqual(filenames("../subagents/triage-critic/connections/"), [
      "autumn.ts",
      "axiom.ts",
      "inngest.ts",
      "intercom.ts",
      "jam.ts",
      "linear.ts",
      "lucent.ts",
      "modem.ts",
      "neon.ts",
      "planetscale.ts",
      "posthog.ts",
      "resend.ts",
      "sentry.ts",
      "stripe.ts",
      "vercel.ts",
    ]);
    assert.deepEqual(filenames("../subagents/triage-critic/tools/"), [
      "ask_question.ts",
      "bash.ts",
      "glob.ts",
      "grep.ts",
      "list_instantly_subworkspaces.ts",
      "planetscale_execute_read_query.ts",
      "read_autumn_billing.ts",
      "read_image.ts",
      "read_instantly_subworkspace.ts",
      "read_stripe_billing.ts",
      "read_triage_review_packet.ts",
      "search_investigation_memory.ts",
      "todo.ts",
      "web_fetch.ts",
      "web_search.ts",
      "write_file.ts",
    ]);
  });

  it("has the product-triage evidence connections", () => {
    for (const name of [
      "axiom",
      "autumn",
      "inngest",
      "intercom",
      "jam",
      "linear",
      "lucent",
      "modem",
      "neon",
      "planetscale",
      "posthog",
      "resend",
      "sentry",
      "stripe",
      "vercel",
    ]) {
      const path = new URL(
        `../subagents/triage-critic/connections/${name}.ts`,
        import.meta.url
      );
      assert.doesNotThrow(() => readFileSync(path, "utf8"), name);
    }
  });

  it("keeps mixed Linear and Vercel surfaces read-only", () => {
    assert.ok(linear.tools && "allow" in linear.tools);
    assert.ok(vercel.tools && "allow" in vercel.tools);
    const linearTools = linear.tools.allow;
    const vercelTools = vercel.tools.allow;
    assert.deepEqual(linearTools, [
      "get_issue",
      "list_comments",
      "list_issue_labels",
      "list_issues",
    ]);
    assert.deepEqual(vercelTools, [...VERCEL_READ_TOOLS]);
    for (const write of [
      "deploy_to_vercel",
      "reply_to_toolbar_thread",
      "edit_toolbar_message",
    ]) {
      assert.equal(
        (vercelTools as readonly string[]).includes(write),
        false,
        write
      );
    }
  });

  it("removes shell, file writes, arbitrary network, and interaction", () => {
    for (const name of [
      "ask_question",
      "bash",
      "todo",
      "web_fetch",
      "web_search",
      "write_file",
    ]) {
      assert.ok(toolSource(name).includes("disableTool"), name);
    }
  });

  it("exposes only read-only authored investigation tools", () => {
    for (const name of [
      "list_instantly_subworkspaces",
      "planetscale_execute_read_query",
      "read_autumn_billing",
      "read_image",
      "read_instantly_subworkspace",
      "read_stripe_billing",
      "read_triage_review_packet",
      "search_investigation_memory",
    ]) {
      assert.doesNotThrow(() => toolSource(name), name);
    }
    for (const forbidden of [
      "complete_triage_master_reservation",
      "correct_investigation_case",
      "read_triage_review_verdict",
      "record_investigation_case",
      "reserve_triage_master",
      "set_agent_models",
    ]) {
      assert.throws(() => toolSource(forbidden), forbidden);
    }
  });

  it("keeps both billing evidence surfaces read-only", () => {
    assert.ok(autumn.tools && "allow" in autumn.tools);
    assert.ok(stripe.tools && "allow" in stripe.tools);
    assert.deepEqual(autumn.tools.allow, [...AUTUMN_READ_TOOLS]);
    assert.deepEqual(stripe.tools.allow, [...STRIPE_READ_TOOLS]);
    for (const write of [
      "getOrCreateCustomer",
      "stripe_api_write",
      "create_refund",
    ]) {
      assert.equal(
        (autumn.tools.allow as readonly string[]).includes(write),
        false,
        write
      );
      assert.equal(
        (stripe.tools.allow as readonly string[]).includes(write),
        false,
        write
      );
    }
  });

  it("attests completed critic output from the parent event stream", () => {
    const hook = readFileSync(
      new URL("../hooks/triage-review-verdict.ts", import.meta.url),
      "utf8"
    );
    assert.ok(hook.includes('"subagent.completed"'));
    assert.ok(hook.includes('event.data.subagentName !== "triage-critic"'));
    assert.ok(hook.includes("triageCriticVerdictSchema.safeParse"));
    assert.ok(hook.includes("ctx.session.id"));
    assert.ok(hook.includes("readVerifiedTriageReviewPacket"));
    assert.ok(hook.includes("attestTriageReviewVerdict"));
  });

  it("uses the shared strict verdict schema at the child boundary", () => {
    const source = readFileSync(
      new URL("../subagents/triage-critic/agent.ts", import.meta.url),
      "utf8"
    );
    assert.ok(source.includes("outputSchema: triageCriticVerdictSchema"));
  });
});
