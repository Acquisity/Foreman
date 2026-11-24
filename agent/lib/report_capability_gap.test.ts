import assert from "node:assert/strict";
import { test } from "node:test";
import { tool } from "../tools/report_capability_gap.js";
import { verifiedWidgetContext as scope } from "./widget.fixture.js";
import { widgetAuth } from "./widget-scope.js";

const ctx = {
  abortSignal: new AbortController().signal,
  session: {
    auth: { current: widgetAuth(scope), initiator: widgetAuth(scope) },
  },
} as never;
const GENERAL = /general terms/u;
const run = (missingFact: string) =>
  tool.execute?.({ area: "orders", kind: "tool", missingFact }, ctx);

test("a general missing fact is recorded for the finish to file", async () => {
  assert.deepEqual(await run("Why a domain order is waiting for payment"), {
    gap: {
      area: "orders",
      fact: "why a domain order is waiting for payment",
      kind: "tool",
    },
    recorded: true,
  });
});

test("a missing fact naming the workspace's data is refused with how to fix it", async () => {
  const refused = (await run("why acme.io's order is stuck")) as {
    error: string;
    recorded: boolean;
  };
  assert.equal(refused.recorded, false);
  assert.match(refused.error, GENERAL);
});

test("outside a support widget session the tool is denied", () => {
  const approval = tool.approval as (context: unknown) => unknown;
  assert.deepEqual(approval({ session: { auth: { initiator: null } } }), {
    reason: "Support widget investigations only.",
    type: "denied",
  });
});
