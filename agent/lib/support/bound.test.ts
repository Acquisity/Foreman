import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SUPPORT_MAX_STEPS,
  SUPPORT_RUN_MS,
  supportDeadline,
  supportRunBoundReached,
} from "./bound.js";

test("support run bound trips on the step cap, the deadline, or a missing stamp", () => {
  const now = 1_000_000;
  const deadline = now + SUPPORT_RUN_MS;
  assert.equal(supportRunBoundReached({ deadline, now, stepIndex: 0 }), false);
  assert.equal(
    supportRunBoundReached({ deadline, now, stepIndex: SUPPORT_MAX_STEPS - 1 }),
    false
  );
  assert.equal(
    supportRunBoundReached({ deadline, now, stepIndex: SUPPORT_MAX_STEPS }),
    true
  );
  assert.equal(
    supportRunBoundReached({ deadline, now: deadline, stepIndex: 0 }),
    true
  );
  assert.equal(
    supportRunBoundReached({ deadline: Number.NaN, now, stepIndex: 0 }),
    true
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
