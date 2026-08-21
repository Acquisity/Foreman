import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConnectionAuthorizationRequiredError,
  type ConnectionPrincipal,
} from "eve/connections";
import type { SessionAuthContext } from "eve/context";
import type { ApprovalContext } from "eve/tools";
import { deliveryPolicy, intakeOnlyPolicy } from "./github/approval.js";
import { parseIntakeOnlyChannels } from "./slack-intake.js";
import { isIntakeOnly, stampIntakeOnly, stampTrusted } from "./trust.js";
import {
  INTAKE_ONLY_SIGN_IN_REASON,
  intakeOnlySignInDenial,
} from "./user-connect.js";

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

  it("denies a lapsed sign-in instead of prompting for it", () => {
    const principalFor = (auth_: SessionAuthContext): ConnectionPrincipal => ({
      attributes: auth_.attributes,
      id: auth_.principalId,
      type: "user",
    });
    const required = new ConnectionAuthorizationRequiredError("jam");
    const denial = intakeOnlySignInDenial(
      required,
      principalFor(stampIntakeOnly(auth))
    );
    assert.equal(denial?.reason, INTAKE_ONLY_SIGN_IN_REASON);
    assert.equal(denial?.retryable, false);
    assert.equal(denial?.connectionName, "jam");
    assert.equal((denial?.message ?? "").includes("jam"), true);

    // A developer channel keeps the normal consent flow, and an unrelated
    // failure is never rewritten into a sign-in denial.
    assert.equal(
      intakeOnlySignInDenial(required, principalFor(auth)),
      undefined
    );
    assert.equal(intakeOnlySignInDenial(required, { type: "app" }), undefined);
    assert.equal(
      intakeOnlySignInDenial(
        new Error("mcp server unreachable"),
        principalFor(stampIntakeOnly(auth))
      ),
      undefined
    );
  });
});
