import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { stampTriageIntake, stampUnattended } from "./trust.js";

const CARD_OR_BANK = /card or bank/u;
const CONFIDENCE_NEEDED = /`\*\*Confidence\*\*: verdict/u;
const REGRESSION_CHECK = /Regression check/u;

process.env.LINEAR_CONNECTOR ??= "linear/test";

const { default: tool, hasCardNumber } = await import(
  "../tools/save_investigation_document.js"
);
const { regressionRecords } = await import("./regression-record.js");

type Context = Parameters<typeof tool.execute>[1];

describe("save_investigation_document tool", () => {
  it("bounds content at 20 000 chars and requires an issue identifier", () => {
    assert.ok(tool.inputSchema instanceof z.ZodType);
    const ok = { content: "x", issue: "ENG-13195", lane: "triage" };
    assert.equal(tool.inputSchema.safeParse(ok).success, true);
    assert.equal(
      tool.inputSchema.safeParse({ ...ok, issue: "ENG-123456789" }).success,
      true
    );
    assert.equal(
      tool.inputSchema.safeParse({ ...ok, content: "x".repeat(20_001) })
        .success,
      false
    );
    assert.equal(
      tool.inputSchema.safeParse({ ...ok, issue: "not an id" }).success,
      false
    );
  });

  it("flags Luhn-valid card numbers and leaves ordinary long ids alone", () => {
    assert.equal(hasCardNumber("4242 4242 4242 4242"), true);
    assert.equal(hasCardNumber("4242-4242-4242-4242"), true);
    for (const id of [
      "Order 20430201049901",
      "subscription 2210123456789",
      "customer 1234567890123",
      "SKU-935-2026-0812-4478",
      "Invoice 10203040506070809",
    ]) {
      assert.equal(hasCardNumber(id), false, id);
    }
  });

  it("allows an unattended schedule through the Linear approval policy", async () => {
    const { approval } = tool;
    assert.equal(typeof approval, "function");
    const status = await (approval as (ctx: unknown) => unknown)({
      session: {
        auth: {
          current: stampUnattended({
            attributes: {},
            authenticator: "app",
            issuer: "eve",
            principalId: "eve:app",
            principalType: "runtime",
          }),
        },
      },
      toolName: "save_investigation_document",
    });
    assert.equal(status, "not-applicable");
  });

  it("refuses a billing document carrying a card or bank number without a token", async () => {
    let requested = false;
    const context = {
      abortSignal: new AbortController().signal,
      getToken: () => {
        requested = true;
        throw new Error("no");
      },
      session: { auth: { current: null, initiator: null } },
    } as unknown as Context;
    const results = (await Promise.all(
      [
        "Card 4242 4242 4242 4242 charged",
        "IBAN gb82west12345698765432",
        "IBAN GB82 WEST 1234 5698 7654 32",
      ].map((content) =>
        tool.execute({ content, issue: "ENG-1", lane: "billing" }, context)
      )
    )) as Array<{ error?: string; saved: boolean }>;
    for (const result of results) {
      assert.equal(result.saved, false);
      assert.match(result.error ?? "", CARD_OR_BANK);
    }
    assert.equal(requested, false);
  });

  it("refuses a triage document without its confidence and review lines before any write", async () => {
    let requested = false;
    const context = {
      abortSignal: new AbortController().signal,
      getToken: () => {
        requested = true;
        throw new Error("no");
      },
      session: { auth: { current: null, initiator: null } },
    } as unknown as Context;
    const result = (await tool.execute(
      {
        content: "# Triage investigation\n\n**Review**: Pending critic",
        issue: "ENG-1",
        lane: "triage",
      },
      context
    )) as { error?: string; saved: boolean };
    assert.equal(result.saved, false);
    assert.match(result.error ?? "", CONFIDENCE_NEEDED);
    assert.equal(requested, false);
  });

  it("refuses sensitive triage-intake billing content before calling the writer", async (t) => {
    const { env } = process;
    process.env = {
      ...env,
      CLIPROXY_API_KEY: "test-key",
      CLIPROXY_BASE_URL: "https://proxy.test/v1",
    };
    t.after(() => {
      process.env = env;
    });
    const fetch = t.mock.method(globalThis, "fetch", () =>
      Promise.resolve(new Response("{}", { status: 400 }))
    );
    const context = {
      abortSignal: new AbortController().signal,
      session: {
        auth: {
          initiator: stampTriageIntake({
            attributes: {},
            authenticator: "app",
            issuer: "eve",
            principalId: "eve:app",
            principalType: "runtime",
          }),
        },
      },
    } as unknown as Context;
    const result = (await tool.execute(
      {
        content: "Card 4242 4242 4242 4242 charged",
        issue: "ENG-1",
        lane: "billing",
      },
      context
    )) as { error?: string; saved: boolean };
    assert.equal(result.saved, false);
    assert.match(result.error ?? "", CARD_OR_BANK);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("refuses a Bug document without the regression check, or one that disagrees with it", async (t) => {
    const read = "a".repeat(40);
    const deployed = "d".repeat(40);
    const fix = "f".repeat(40);
    const line = `fixed on main and live, by ${fix}`;
    const record = {
      commit: fix,
      commitRead: read,
      deployedCommit: deployed,
      issue: "ENG-1",
      kind: "fixed_live" as const,
      line,
      windowDays: 30,
    };
    t.mock.method(regressionRecords, "get", () => ({ "ENG-1": record }));
    const context = {
      abortSignal: new AbortController().signal,
      session: { auth: { current: null, initiator: null } },
    } as unknown as Context;
    const bug = (section: string) =>
      `# Triage investigation\n\n**Classification**: Bug\n\n${section}\n## Code path\nsend.ts\n`;
    const results = (await Promise.all(
      [
        bug(""),
        bug(
          `## Regression check\n**Deployed commit**: ${deployed}\n**Commit read**: ${read}\n**Result**: none\n`
        ),
      ].map((content) =>
        tool.execute({ content, issue: "ENG-1", lane: "triage" }, context)
      )
    )) as Array<{ error?: string; saved: boolean }>;
    for (const result of results) {
      assert.equal(result.saved, false);
      assert.match(result.error ?? "", REGRESSION_CHECK);
    }
  });
});
