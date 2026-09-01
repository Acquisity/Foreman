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
  FINAL_SLACK_POST_RULE,
  parseIntakeOnlyChannels,
  resolveSlackIntakeWorkflow,
  slackIntakeContext,
  stampSlackIntakeAuth,
} from "./slack-intake.js";
import {
  canUseBillingApiRead,
  isIntakeOnly,
  stampIntakeOnly,
  stampTrusted,
} from "./trust.js";
import { SLACK_SIGN_IN_REASON, slackSignInDenial } from "./user-connect.js";

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

  it("maps billing triage and its sandbox to the same workflow", () => {
    const production = resolveSlackIntakeWorkflow("C0BC011NAQL");
    const sandbox = resolveSlackIntakeWorkflow("C0BMXPV6EGJ");
    assert.deepEqual(production, sandbox);
    assert.equal(production?.mode, "existing-linear-issue");
    assert.deepEqual(production?.skills, [
      "billing-triage",
      "clarify-with-requester",
      "slack-wording",
    ]);
  });

  it("billing API reads run on every surface except an untrusted GitHub session", () => {
    const intake = stampSlackIntakeAuth(auth);
    assert.equal(isIntakeOnly(intake), true);
    assert.equal(canUseBillingApiRead(intake), true);
    assert.equal(canUseBillingApiRead(auth), true);
    assert.equal(canUseBillingApiRead(stampIntakeOnly(auth)), true);
    assert.equal(canUseBillingApiRead(null), true);
    const github = { ...auth, principalId: "github:12345" };
    assert.equal(canUseBillingApiRead(github), false);
    assert.equal(canUseBillingApiRead(stampTrusted(github)), true);
  });

  it("maps Intercom and its sandbox to the dedicated new-issue workflow", () => {
    const production = resolveSlackIntakeWorkflow("C0BCV1WBR42");
    const sandbox = resolveSlackIntakeWorkflow("C0BNCL031AQ");
    assert.deepEqual(production, sandbox);
    assert.equal(production?.mode, "new-linear-issue");
    assert.deepEqual(production?.skills, [
      "intercom-triage-investigate",
      "intercom-billing-triage",
      "clarify-with-requester",
      "slack-wording",
    ]);
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
    assert.equal(context.includes("The final post in the Slack thread"), true);
    assert.equal(context.includes("progress updates are allowed"), true);
    assert.equal(context.includes("only the requester-facing answer"), true);
    assert.equal(context.includes("no internal summary or action log"), true);
  });

  it("states the final Slack-post rule exactly once per intake context", () => {
    for (const channelId of ["C0BBPVC3N2X", "C0BC011NAQL", "C0BCV1WBR42"]) {
      const context = slackIntakeContext(channelId);
      const occurrences = context.split(FINAL_SLACK_POST_RULE).length - 1;
      assert.equal(occurrences, 1, channelId);
    }
  });

  it("starts Intercom intake from one conversation without an issue", () => {
    const context = slackIntakeContext("C0BCV1WBR42");
    assert.equal(
      context.includes("No Linear issue is expected at the start"),
      true
    );
    assert.equal(
      context.includes("exactly one live Intercom conversation"),
      true
    );
    assert.equal(context.includes("product/feedback or billing"), true);
    assert.equal(
      context.includes("Both lanes are valid in this channel"),
      true
    );
    assert.equal(context.includes("intercom-triage-investigate"), true);
    assert.equal(context.includes("intercom-billing-triage"), true);
    assert.equal(
      context.includes("Create exactly one unassigned Linear issue"),
      false
    );
    assert.equal(context.includes("no dedicated channel skill yet"), false);
    assert.equal(context.includes("stop before implementation"), true);
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
    const slackAuth: SessionAuthContext = {
      ...auth,
      principalId: "slack:T123:U456",
    };
    const required = new ConnectionAuthorizationRequiredError("jam");
    const denial = slackSignInDenial(
      required,
      principalFor(stampIntakeOnly(slackAuth))
    );
    assert.equal(denial?.reason, SLACK_SIGN_IN_REASON);
    assert.equal(denial?.retryable, false);
    assert.equal(denial?.connectionName, "jam");
    assert.equal((denial?.message ?? "").includes("jam"), false);
    assert.equal(
      (denial?.message ?? "").includes("optional evidence source"),
      true
    );

    // The denial covers every Slack-issued user principal now, so an
    // unstamped developer-channel mention is denied the same way. An app
    // principal never reaches the consent flow at all, and an unrelated
    // failure is never rewritten into a sign-in denial.
    assert.ok(slackSignInDenial(required, principalFor(slackAuth)));
    assert.equal(slackSignInDenial(required, { type: "app" }), undefined);
    assert.equal(
      slackSignInDenial(
        new Error("mcp server unreachable"),
        principalFor(stampIntakeOnly(slackAuth))
      ),
      undefined
    );
  });
});
