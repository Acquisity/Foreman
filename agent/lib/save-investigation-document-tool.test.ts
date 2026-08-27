import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { AUTONOMOUS_PRINCIPAL } from "./trust.js";

const CARD_OR_BANK = /card or bank/u;

process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planet-scale-read-only-foreman/test";

const { default: tool } = await import(
  "../tools/save_investigation_document.js"
);

type Context = Parameters<typeof tool.execute>[1];

describe("save_investigation_document tool", () => {
  it("bounds content at 20 000 chars and requires an issue identifier", () => {
    assert.ok(tool.inputSchema instanceof z.ZodType);
    const ok = { content: "x", issue: "ENG-13195", lane: "triage" };
    assert.equal(tool.inputSchema.safeParse(ok).success, true);
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

  it("denies an autonomous run before any request", async () => {
    const { approval } = tool;
    assert.equal(typeof approval, "function");
    const status = await (approval as (ctx: unknown) => unknown)({
      session: {
        auth: {
          current: {
            attributes: {},
            authenticator: "github",
            principalId: AUTONOMOUS_PRINCIPAL,
            principalType: "service",
          },
        },
      },
      toolName: "save_investigation_document",
    });
    assert.deepEqual(status, {
      reason: "Unattended runs do not write to Linear.",
      type: "denied",
    });
  });

  it("refuses a billing document carrying a card or bank number without a token", async () => {
    let requested = false;
    const context = {
      abortSignal: new AbortController().signal,
      getToken: () => {
        requested = true;
        throw new Error("no");
      },
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
});
