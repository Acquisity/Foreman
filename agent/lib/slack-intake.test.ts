import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { ApprovalContext } from "eve/tools";
import { deliveryPolicy, intakeOnlyPolicy } from "./github/approval.js";
import { parseIntakeOnlyChannels } from "./slack-intake.js";
import { isIntakeOnly, stampIntakeOnly, stampTrusted } from "./trust.js";

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
});
