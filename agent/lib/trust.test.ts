import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionAuthContext } from "eve/context";
import {
  AUTONOMOUS_PRINCIPAL,
  isUnattended,
  UNATTENDED_ATTRIBUTE,
} from "./trust.js";

const auth = (
  overrides: Partial<SessionAuthContext> = {}
): SessionAuthContext =>
  ({
    attributes: {},
    authenticator: "slack-webhook",
    issuer: "slack:T1",
    principalId: "slack:T1:U1",
    principalType: "user",
    ...overrides,
  }) as SessionAuthContext;

test("isUnattended", async (t) => {
  await t.test("is false for an ordinary user turn", () => {
    assert.equal(isUnattended(auth()), false);
  });

  await t.test("is true for the autonomous factory principal", () => {
    assert.equal(
      isUnattended(auth({ principalId: AUTONOMOUS_PRINCIPAL })),
      true
    );
  });

  await t.test("is true for a stamped user principal", () => {
    assert.equal(
      isUnattended(auth({ attributes: { [UNATTENDED_ATTRIBUTE]: "true" } })),
      true
    );
  });

  await t.test("is false with no auth", () => {
    assert.equal(isUnattended(null), false);
  });
});
