import assert from "node:assert/strict";
import { test } from "node:test";
import hook from "../../hooks/support-bound.js";
import { SUPPORT_MAX_STEPS, SUPPORT_RUN_MS } from "./bound.js";

const handler = hook.events?.["step.started"] as (
  event: unknown,
  ctx: unknown
) => unknown;

const stepStarted = (stepIndex: number) => ({
  data: { modelId: "m", sequence: 1, stepIndex, turnId: "t" },
  type: "step.started",
});
const context = (issuer: string, deadline: string, parent?: unknown) => ({
  session: {
    auth: {
      current: null,
      initiator: {
        attributes: { deadline },
        issuer,
        principalType: "app",
        subject: "s",
      },
    },
    id: "session",
    parent,
  },
});
const live = String(Date.now() + SUPPORT_RUN_MS);
const support = "foreman:intercom-support";
const bound = /run bound/;

test("support bound hook fails the turn only for a support root past its bound", () => {
  assert.throws(
    () => handler(stepStarted(SUPPORT_MAX_STEPS), context(support, live)),
    bound
  );
  assert.throws(
    () => handler(stepStarted(0), context(support, String(Date.now() - 1))),
    bound
  );
  assert.doesNotThrow(() => handler(stepStarted(0), context(support, live)));
  assert.doesNotThrow(() =>
    handler(stepStarted(SUPPORT_MAX_STEPS), context("slack", "0"))
  );
  assert.doesNotThrow(() =>
    handler(stepStarted(SUPPORT_MAX_STEPS), context(support, "0", { id: "p" }))
  );
});
