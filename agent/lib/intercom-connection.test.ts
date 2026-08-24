import assert from "node:assert/strict";
import test from "node:test";
import type { SessionAuthContext } from "eve/context";
import type { ApprovalContext } from "eve/tools";
import {
  AUTONOMOUS_PRINCIPAL,
  stampInvestigationMemory,
  stampTrusted,
} from "./trust.js";

process.env.INTERCOM_MCP_CONNECTOR ??=
  "api.intercom.com/acquisity-foreman-intercom-api";
process.env.LINEAR_CONNECTOR ??= "linear/test";
process.env.PLANETSCALE_MCP_CONNECTOR ??= "planet-scale-read-only-foreman/test";

const { default: intercom } = await import("../connections/intercom.js");

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

const approve = (current: SessionAuthContext | null) => {
  assert.equal(typeof intercom.approval, "function");
  return (intercom.approval as (ctx: ApprovalContext) => unknown)({
    session: { auth: { current } },
    toolInput: {},
    toolName: "intercom__search_conversations",
  } as unknown as ApprovalContext);
};

test("Intercom stays app-scoped with the least-privilege tool set", () => {
  assert.equal(typeof intercom.auth, "object");

  if (typeof intercom.auth !== "object" || intercom.auth === null) {
    assert.fail("Intercom auth must be a static app-scoped definition");
  }

  assert.equal(intercom.auth.principalType, "app");
  assert.equal("startAuthorization" in intercom.auth, false);
  assert.deepEqual(intercom.tools, {
    allow: [
      "fetch",
      "get_company",
      "get_contact",
      "get_conversation",
      "list_companies",
      "search",
      "search_contacts",
      "search_conversations",
    ],
  });
});

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
