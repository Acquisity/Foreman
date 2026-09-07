/**
 * Lives in `lib/` rather than beside the connection because eve discovers one
 * connection per file under `agent/connections/`, so a test file there is read
 * as a connection and fails the build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTONOMOUS_PRINCIPAL, UNATTENDED_ATTRIBUTE } from "./trust.js";

process.env.LINEAR_CONNECTOR ??= "linear/test";

import type { SessionAuthContext } from "eve/context";
import { providerAllowlist } from "./executor/policy.js";
import { executorProfile } from "./executor/profiles.js";

const approve = (toolName: string, auth: Record<string, unknown> | null) => {
  const allowed = providerAllowlist(
    "linear",
    "root",
    executorProfile(auth as SessionAuthContext | null)
  );
  const name = toolName.replace("linear__", "");
  return allowed.includes("*") || allowed.includes(name)
    ? "not-applicable"
    : { type: "denied" };
};

const SCHEDULED = { attributes: { [UNATTENDED_ATTRIBUTE]: "true" } };
const FACTORY = { attributes: {}, principalId: AUTONOMOUS_PRINCIPAL };
const ATTENDED = { attributes: {}, principalId: "slack:T1:U1" };

test("linear connection approval", async (t) => {
  await t.test("lets a scheduled run read the tracker", () => {
    assert.equal(approve("linear__list_issues", SCHEDULED), "not-applicable");
    assert.equal(approve("linear__get_issue", SCHEDULED), "not-applicable");
  });

  await t.test("matches an unqualified tool name too", () => {
    assert.equal(approve("list_issues", SCHEDULED), "not-applicable");
  });

  await t.test("allows scheduled and factory Linear reads and writes", () => {
    for (const auth of [SCHEDULED, FACTORY]) {
      assert.equal(approve("linear__list_issues", auth), "not-applicable");
      assert.equal(approve("linear__save_issue", auth), "not-applicable");
    }
  });

  await t.test("leaves attended sessions ungated", () => {
    assert.equal(approve("linear__save_issue", ATTENDED), "not-applicable");
  });
});
