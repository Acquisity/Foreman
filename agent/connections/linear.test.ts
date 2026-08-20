import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApprovalContext } from "eve/tools";
import { AUTONOMOUS_PRINCIPAL, UNATTENDED_ATTRIBUTE } from "../lib/trust.js";

process.env.LINEAR_CONNECTOR ??= "linear/test";
const linear = (await import("./linear.js")).default;

const approve = (toolName: string, auth: Record<string, unknown> | null) =>
  (linear.approval as (ctx: ApprovalContext) => unknown)({
    session: { auth: { current: auth } },
    toolName,
  } as unknown as ApprovalContext);

const SCHEDULED = { attributes: { [UNATTENDED_ATTRIBUTE]: "true" } };
const FACTORY = { attributes: {}, principalId: AUTONOMOUS_PRINCIPAL };
const ATTENDED = { attributes: {}, principalId: "slack:T1:U1" };

test("linear connection approval", async (t) => {
  await t.test("lets a scheduled run read the tracker", () => {
    assert.equal(approve("linear__list_issues", SCHEDULED), "not-applicable");
    assert.equal(approve("linear__get_issue", SCHEDULED), "not-applicable");
  });

  await t.test("denies a scheduled run every other Linear tool", () => {
    assert.equal(
      (approve("linear__save_issue", SCHEDULED) as { type: string }).type,
      "denied"
    );
  });

  await t.test("denies a factory run even the reads", () => {
    assert.equal(
      (approve("linear__list_issues", FACTORY) as { type: string }).type,
      "denied"
    );
  });

  await t.test("leaves attended sessions ungated", () => {
    assert.equal(approve("linear__save_issue", ATTENDED), "not-applicable");
  });
});
