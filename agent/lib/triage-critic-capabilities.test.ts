import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planetscale/test";
process.env.VERCEL_MCP_CONNECTOR ??= "vercel/test";

const [{ default: linear }, { default: vercel }] = await Promise.all([
  import("../subagents/triage-critic/connections/linear.js"),
  import("../subagents/triage-critic/connections/vercel.js"),
]);

const toolSource = (name: string): string =>
  readFileSync(
    new URL(`../subagents/triage-critic/tools/${name}.ts`, import.meta.url),
    "utf8"
  );

describe("triage-critic capabilities", () => {
  it("has the product-triage evidence connections", () => {
    for (const name of [
      "axiom",
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
    assert.ok(vercelTools.includes("get_runtime_errors"));
    for (const write of [
      "deploy_to_vercel",
      "reply_to_toolbar_thread",
      "edit_toolbar_message",
    ]) {
      assert.equal(vercelTools.includes(write), false, write);
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
      "read_image",
      "read_instantly_subworkspace",
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
});
