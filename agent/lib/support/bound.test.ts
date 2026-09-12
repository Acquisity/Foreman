import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countSupportStep,
  SUPPORT_MAX_STEPS,
  SUPPORT_RUN_MS,
  supportDeadline,
  supportRunBoundReached,
} from "./bound.js";

test("support run bound permits 150 steps and trips on the next step or deadline", () => {
  const now = 1_000_000;
  const deadline = now + SUPPORT_RUN_MS;
  assert.equal(supportRunBoundReached({ deadline, now, steps: 1 }), false);
  assert.equal(
    supportRunBoundReached({ deadline, now, steps: SUPPORT_MAX_STEPS }),
    false
  );
  assert.equal(
    supportRunBoundReached({ deadline, now, steps: SUPPORT_MAX_STEPS + 1 }),
    true
  );
  assert.equal(
    supportRunBoundReached({ deadline, now: deadline, steps: 1 }),
    true
  );
  assert.equal(
    supportRunBoundReached({ deadline: Number.NaN, now, steps: 1 }),
    true
  );
});

test("count spans result turns and ignores repeated steps in the current turn", () => {
  const first = countSupportStep(
    { count: 0, stepIndex: -1, turnId: null },
    { stepIndex: 0, turnId: "initial" }
  );
  const second = countSupportStep(first, { stepIndex: 1, turnId: "initial" });
  assert.equal(second.count, 2);
  assert.equal(
    countSupportStep(second, { stepIndex: 1, turnId: "initial" }),
    second
  );
  assert.equal(
    countSupportStep(second, { stepIndex: 0, turnId: "initial" }),
    second
  );
  assert.deepEqual(
    countSupportStep(second, { stepIndex: 0, turnId: "result" }),
    {
      count: 3,
      stepIndex: 0,
      turnId: "result",
    }
  );
});

test("support deadline is read back from the auth stamp and fails closed otherwise", () => {
  const base = { issuer: "x", principalType: "app", subject: "s" } as const;
  assert.equal(
    supportDeadline({ ...base, attributes: { deadline: "42" } } as never),
    42
  );
  assert.equal(
    Number.isNaN(supportDeadline({ ...base, attributes: {} } as never)),
    true
  );
  assert.equal(Number.isNaN(supportDeadline(null)), true);
});
