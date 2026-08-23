import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { ApprovalContext } from "eve/tools";
import { investigationMemoryWritePolicy } from "../github/approval.js";
import {
  AUTONOMOUS_PRINCIPAL,
  canUseInvestigationMemory,
  stampInvestigationMemory,
  stampTrusted,
  UNATTENDED_ATTRIBUTE,
} from "../trust.js";

const auth = (
  overrides: Partial<SessionAuthContext> = {}
): SessionAuthContext =>
  ({
    attributes: {},
    authenticator: "linear-webhook",
    issuer: "linear:acquisity",
    principalId: "linear:acquisity:U1",
    principalType: "user",
    ...overrides,
  }) as SessionAuthContext;

const approval = (current: SessionAuthContext | null): ApprovalContext =>
  ({
    session: { auth: { current } },
    toolInput: {},
    toolName: "record_investigation_case",
  }) as unknown as ApprovalContext;

test("canUseInvestigationMemory", async (t) => {
  await t.test("is false for an unstamped session", () => {
    assert.equal(canUseInvestigationMemory(auth()), false);
  });

  await t.test("is false with no auth at all", () => {
    assert.equal(canUseInvestigationMemory(null), false);
  });

  await t.test("is false for a trusted GitHub collaborator", () => {
    const github = stampTrusted(
      auth({
        authenticator: "github-webhook",
        issuer: "github",
        principalId: "github:12345",
      })
    );
    assert.equal(canUseInvestigationMemory(github), false);
  });

  await t.test("is false for an unattended factory run", () => {
    const factory = stampInvestigationMemory(
      auth({ principalId: AUTONOMOUS_PRINCIPAL })
    );
    assert.equal(canUseInvestigationMemory(factory), false);
  });

  await t.test("is false for a schedule dispatching under a user", () => {
    const schedule = stampInvestigationMemory(
      auth({ attributes: { [UNATTENDED_ATTRIBUTE]: "true" } })
    );
    assert.equal(canUseInvestigationMemory(schedule), false);
  });

  await t.test("is true for a stamped attended triage session", () => {
    assert.equal(
      canUseInvestigationMemory(stampInvestigationMemory(auth())),
      true
    );
  });
});

test("investigationMemoryWritePolicy", async (t) => {
  await t.test("denies an unattended run", () => {
    const status = investigationMemoryWritePolicy(
      approval(
        stampInvestigationMemory(auth({ principalId: AUTONOMOUS_PRINCIPAL }))
      )
    );
    assert.deepEqual(status, {
      reason: "Unattended runs may not write investigation memory.",
      type: "denied",
    });
  });

  await t.test("denies an unstamped session rather than parking it", () => {
    const status = investigationMemoryWritePolicy(
      approval(stampTrusted(auth()))
    );
    assert.equal(typeof status === "object" ? status.type : status, "denied");
  });

  await t.test("never parks on an approval card", () => {
    for (const current of [null, auth(), stampTrusted(auth())]) {
      const status = investigationMemoryWritePolicy(approval(current));
      assert.notEqual(status, "user-approval");
    }
  });

  await t.test("lets an authorized triage session write", () => {
    assert.equal(
      investigationMemoryWritePolicy(
        approval(stampInvestigationMemory(stampTrusted(auth())))
      ),
      "not-applicable"
    );
  });
});
