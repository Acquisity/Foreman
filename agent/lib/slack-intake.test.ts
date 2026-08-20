import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { ApprovalContext } from "eve/tools";
import { deliveryPolicy, intakeOnlyPolicy } from "./github/approval.js";
import { parseIntakeOnlyChannels } from "./slack-intake.js";
import {
  isAutonomous,
  isIntakeOnly,
  stampAutonomous,
  stampIntakeOnly,
  stampTrusted,
} from "./trust.js";

const auth: SessionAuthContext = {
  attributes: {},
  authenticator: "slack",
  principalId: "user:1",
  principalType: "user",
};

const approvalFor = (current: SessionAuthContext) =>
  ({
    session: { auth: { current } },
    toolName: "push_branch",
  }) as unknown as ApprovalContext;

describe("intake-only channels", () => {
  it("parses a comma-separated channel list, trimming and dropping empties", () => {
    const parsed = parseIntakeOnlyChannels("  C0BBPVC3N2X , , C0BC011NAQL ,");
    assert.deepEqual([...parsed].sort(), ["C0BBPVC3N2X", "C0BC011NAQL"]);
    assert.equal(parsed.has("C0000000000"), false);
    assert.equal(parseIntakeOnlyChannels(undefined).size, 0);
    assert.equal(parseIntakeOnlyChannels("").size, 0);
    assert.equal(parseIntakeOnlyChannels("#product-requests").size, 0);
    assert.equal(
      parseIntakeOnlyChannels("c0bbpvc3n2x").has("C0BBPVC3N2X"),
      true
    );
  });

  it("denies delivery for an intake-only session", () => {
    const stamped = stampIntakeOnly(stampTrusted(auth));
    assert.equal(isIntakeOnly(stamped), true);
    for (const policy of [intakeOnlyPolicy, deliveryPolicy]) {
      const status = policy(approvalFor(stamped));
      assert.equal(typeof status === "object" && status.type, "denied");
    }
  });

  it("gates delivery by caller trust, not just intake-only status", () => {
    assert.equal(isIntakeOnly(auth), false);
    assert.equal(intakeOnlyPolicy(approvalFor(auth)), "not-applicable");
    assert.equal(
      intakeOnlyPolicy(approvalFor(stampTrusted(auth))),
      "not-applicable"
    );

    // Untrusted attended caller parks on a card.
    assert.equal(deliveryPolicy(approvalFor(auth)), "user-approval");
    // Trusted caller publishes without a card.
    assert.equal(
      deliveryPolicy(approvalFor(stampTrusted(auth))),
      "not-applicable"
    );
    // Autonomous runs are denied, never parked.
    const autonomous = stampAutonomous(auth, 123);
    assert.equal(isAutonomous(autonomous), true);
    const denied = deliveryPolicy(approvalFor(autonomous));
    assert.equal(typeof denied === "object" && denied.type, "denied");
  });
});
