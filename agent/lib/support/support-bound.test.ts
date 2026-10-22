import assert from "node:assert/strict";
import { mock, test } from "node:test";
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
  cancel: mock.fn(),
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
const cancels = (
  run: (ctx: ReturnType<typeof context>) => unknown,
  ctx: ReturnType<typeof context>
) => {
  assert.doesNotThrow(() => run(ctx));
  return ctx.cancel.mock.callCount();
};

test("support step cap survives later parent turns without charging retries twice", () => {
  const store = new ContextContainer();
  const inStep = (stepIndex: number, turnId = "initial") =>
    cancels(
      (ctx) =>
        contextStorage.run(store, () =>
          handler(stepStarted(stepIndex, turnId), ctx)
        ),
      context(support, live)
    );
  for (let step = 0; step < SUPPORT_MAX_STEPS - 1; step += 1) {
    assert.equal(inStep(step), 0);
    assert.equal(inStep(step), 0);
  }
  assert.equal(inStep(0, "child-result"), 0);
  assert.equal(inStep(0, "child-result"), 0);
  assert.equal(inStep(1, "child-result"), 1);
  // A different session gets its own fresh counter.
  const fresh = (ctx: ReturnType<typeof context>) =>
    contextStorage.run(new ContextContainer(), () =>
      handler(stepStarted(0), ctx)
    );
  assert.equal(cancels(fresh, context(support, live)), 0);
});

test("deadline cancels the root while attended sessions and child steps are uncounted", () => {
  const step = (ctx: ReturnType<typeof context>) =>
    contextStorage.run(new ContextContainer(), () =>
      handler(stepStarted(0), ctx)
    );
  assert.equal(cancels(step, context(support, String(Date.now() - 1))), 1);
  assert.equal(cancels(step, context(support, "")), 1);
  assert.equal(cancels(step, context("slack", "0")), 0);
  assert.equal(cancels(step, context(support, "0", { id: "p" })), 0);
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
      const wait = (ctx: ReturnType<typeof context>) =>
        deny({ data: { turnId: "t" } }, ctx);
      assert.equal(cancels(wait, context(support, live)), 1);
      assert.equal(cancels(wait, context(support, live, { id: "p" })), 1);
      assert.equal(cancels(wait, context("slack", live)), 0);
    }
  }
});
