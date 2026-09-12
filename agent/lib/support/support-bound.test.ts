import assert from "node:assert/strict";
import { test } from "node:test";
import hook from "../../hooks/support-bound.js";
import criticHook from "../../subagents/critic/hooks/support-bound.js";
import visionHook from "../../subagents/vision/hooks/support-bound.js";
import { evePackageUrl } from "../eve-dynamic-tools.js";
import { SUPPORT_MAX_STEPS, SUPPORT_RUN_MS } from "./bound.js";

const handler = hook.events?.["step.started"] as (
  event: unknown,
  ctx: unknown
) => unknown;
const { ContextContainer, contextStorage } = (await import(
  new URL("./dist/src/context/container.js", evePackageUrl()).href
)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run: <T>(store: unknown, body: () => T) => T };
};
const stepStarted = (stepIndex: number, turnId = "initial") => ({
  data: { modelId: "m", sequence: 1, stepIndex, turnId },
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
const cannotWait = /cannot wait/;

test("support step cap survives later parent turns without charging retries twice", () => {
  const store = new ContextContainer();
  const inStep = (stepIndex: number, turnId = "initial") =>
    contextStorage.run(store, () =>
      handler(stepStarted(stepIndex, turnId), context(support, live))
    );
  for (let step = 0; step < SUPPORT_MAX_STEPS - 1; step += 1) {
    inStep(step);
    inStep(step);
  }
  assert.doesNotThrow(() => inStep(0, "child-result"));
  assert.doesNotThrow(() => inStep(0, "child-result"));
  assert.throws(() => inStep(1, "child-result"), bound);
  // A different session gets its own fresh counter.
  contextStorage.run(new ContextContainer(), () =>
    assert.doesNotThrow(() => handler(stepStarted(0), context(support, live)))
  );
});

test("deadline fails the root while attended sessions and child steps are uncounted", () => {
  contextStorage.run(new ContextContainer(), () => {
    assert.throws(
      () => handler(stepStarted(0), context(support, String(Date.now() - 1))),
      bound
    );
    assert.throws(() => handler(stepStarted(0), context(support, "")), bound);
  });
  assert.doesNotThrow(() => handler(stepStarted(0), context("slack", "0")));
  assert.doesNotThrow(() =>
    handler(stepStarted(0), context(support, "0", { id: "p" }))
  );
});

test("support root and declared child hooks reject input and authorization waits", () => {
  for (const definition of [hook, criticHook, visionHook]) {
    for (const event of [
      "input.requested",
      "authorization.required",
    ] as const) {
      const deny = definition.events?.[event] as (
        event: unknown,
        ctx: unknown
      ) => unknown;
      assert.throws(() => deny({}, context(support, live)), cannotWait);
      assert.throws(
        () => deny({}, context(support, live, { id: "p" })),
        cannotWait
      );
      assert.doesNotThrow(() => deny({}, context("slack", live)));
    }
  }
});
