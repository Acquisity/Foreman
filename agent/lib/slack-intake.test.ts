import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConnectionAuthorizationRequiredError,
  type ConnectionPrincipal,
} from "eve/connections";
import type { SessionAuthContext } from "eve/context";
import type { ApprovalContext } from "eve/tools";
import { deliveryPolicy, intakeOnlyPolicy } from "./github/approval.js";
import {
  parseIntakeOnlyChannels,
  resolveSlackIntakeWorkflow,
  slackIntakeContext,
} from "./slack-intake.js";
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

  it("maps product triage and its sandbox to the same existing-issue workflow", () => {
    const production = resolveSlackIntakeWorkflow("C0BBPVC3N2X");
    const sandbox = resolveSlackIntakeWorkflow("C0BLFDUN6Q7");
    assert.deepEqual(production, sandbox);
    assert.equal(production?.mode, "existing-linear-issue");
    assert.deepEqual(production?.skills, [
      "triage-investigate",
      "clarify-with-requester",
      "slack-wording",
    ]);
  });

  it("maps billing triage to its existing-issue workflow", () => {
    const workflow = resolveSlackIntakeWorkflow("C0BC011NAQL");
    assert.equal(workflow?.mode, "existing-linear-issue");
    assert.deepEqual(workflow?.skills, [
      "billing-triage",
      "clarify-with-requester",
      "slack-wording",
    ]);
  });

  it("maps Intercom and its sandbox to the generic new-issue workflow", () => {
    const production = resolveSlackIntakeWorkflow("C0BCV1WBR42");
    const sandbox = resolveSlackIntakeWorkflow("C0BNCL031AQ");
    assert.deepEqual(production, sandbox);
    assert.equal(production?.mode, "new-linear-issue");
    assert.deepEqual(production?.skills, []);
  });

  it("instructs existing-issue channels not to create duplicates", () => {
    const context = slackIntakeContext("C0BBPVC3N2X");
    assert.equal(
      context.includes("Never create a duplicate Linear issue"),
      true
    );
    assert.equal(context.includes("exactly one existing Linear issue"), true);
    assert.equal(context.includes("Linear link or identifier"), true);
    assert.equal(context.includes("triage-investigate"), true);
  });

  it("instructs new-issue channels to file once and stop", () => {
    const context = slackIntakeContext("C0BCV1WBR42");
    assert.equal(
      context.includes("Create exactly one unassigned Linear issue"),
      true
    );
    assert.equal(context.includes("stop before implementation"), true);
    assert.equal(context.includes("no dedicated channel skill yet"), true);
    assert.equal(
      context.includes("start the factory implementation pipeline"),
      true
    );
  });

  it("denies delivery for an intake-only session", () => {
    const stamped = stampIntakeOnly(stampTrusted(auth));
    assert.equal(isIntakeOnly(stamped), true);
    for (const policy of [intakeOnlyPolicy, deliveryPolicy]) {
      const status = policy(approvalFor(stamped));
      assert.equal(typeof status === "object" && status.type, "denied");
      assert.equal(
        typeof status === "object" &&
          (status.reason?.includes("Linear") ?? false),
        false
      );
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
    assert.equal((denial?.message ?? "").includes("jam"), false);
    assert.equal(
      (denial?.message ?? "").includes("optional evidence source"),
      true
    );

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
