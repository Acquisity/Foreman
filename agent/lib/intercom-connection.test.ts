import assert from "node:assert/strict";
import test from "node:test";
import type { SessionAuthContext } from "eve/context";
import {
  AUTONOMOUS_PRINCIPAL,
  stampInvestigationMemory,
  stampTrusted,
} from "./trust.js";

process.env.LINEAR_CONNECTOR ??= "linear/test";

import { providerAllowlist } from "./executor/policy.js";
import { executorProfile } from "./executor/profiles.js";

const auth = (
  overrides: Partial<SessionAuthContext> = {}
): SessionAuthContext =>
  ({
    attributes: {},
    authenticator: "github-webhook",
    issuer: "github",
    principalId: "github:outside-contributor",
    principalType: "user",
    ...overrides,
  }) as SessionAuthContext;

const approve = (current: SessionAuthContext | null) =>
  providerAllowlist("intercom", "root", executorProfile(current)).length
    ? "not-applicable"
    : {
        reason:
          "Intercom customer data is limited to trusted internal and explicitly authorized factory sessions.",
        type: "denied",
      };

test("Intercom reads reject public PR summaries without blocking internal work", async (t) => {
  const denied = {
    reason:
      "Intercom customer data is limited to trusted internal and explicitly authorized factory sessions.",
    type: "denied",
  };

  await t.test("denies an outside-contributor PR summary session", () => {
    assert.deepEqual(approve(auth()), denied);
  });

  await t.test("denies an unauthenticated session", () => {
    assert.deepEqual(approve(null), denied);
  });

  await t.test("allows a trusted internal session", () => {
    assert.equal(approve(stampTrusted(auth())), "not-applicable");
  });

  await t.test("allows an attended investigation surface", () => {
    assert.equal(approve(stampInvestigationMemory(auth())), "not-applicable");
  });

  await t.test("preserves the explicitly triggered factory path", () => {
    assert.equal(
      approve(
        auth({
          principalId: AUTONOMOUS_PRINCIPAL,
          principalType: "service",
        })
      ),
      "not-applicable"
    );
  });
});
