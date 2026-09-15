import assert from "node:assert/strict";
import { test } from "node:test";
import { updateFinInvestigationReceipt } from "./fin-investigation-slack.js";

test("Slack receipt updates neutralize model-authored mentions", async () => {
  const calls: Array<{ input: Record<string, string>; operation: string }> = [];
  const receipt = { channel: "C0BUF4GU8C8", delivered: false, ts: "1.0" };
  await updateFinInvestigationReceipt(
    receipt,
    {
      message: "Could not inspect <@U123> or <!channel> & no action was taken.",
      status: "failed",
    },
    (operation, input) => {
      calls.push({ input, operation });
      return Promise.resolve({ ok: true as const, ts: receipt.ts });
    }
  );
  assert.equal(receipt.delivered, true);
  assert.deepEqual(calls, [
    {
      input: {
        channel: "C0BUF4GU8C8",
        text: "*Investigation unavailable*\n\nCould not inspect &lt;@U123&gt; or &lt;!channel&gt; &amp; no action was taken.",
        ts: "1.0",
      },
      operation: "chat.update",
    },
  ]);
});
