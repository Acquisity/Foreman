import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionAuthContext } from "eve/context";
import { verifiedFinContext } from "./fin-investigation.fixture.js";
import {
  FIN_INVESTIGATION_ISSUER,
  finInvestigationAuth,
  finInvestigationContext,
  isFinInvestigation,
  requireFinInvestigationContext,
} from "./fin-investigation-auth.js";

test("stamps and recovers only the complete server-verified investigation scope", () => {
  const auth = finInvestigationAuth(verifiedFinContext);
  assert.equal(auth.issuer, FIN_INVESTIGATION_ISSUER);
  assert.equal(auth.principalId, verifiedFinContext.userId);
  assert.deepEqual(finInvestigationContext(auth), verifiedFinContext);
  assert.deepEqual(requireFinInvestigationContext(auth), verifiedFinContext);
});

test("a malformed customer issuer stays identified as customer but has no usable scope", () => {
  const forged = {
    ...finInvestigationAuth(verifiedFinContext),
    attributes: {
      ...verifiedFinContext,
      organizationId: "not-a-workspace",
      organizationSlug: "another-workspace",
    },
  } satisfies SessionAuthContext;
  assert.equal(isFinInvestigation(forged), true);
  assert.equal(finInvestigationContext(forged), null);
  assert.throws(() => requireFinInvestigationContext(forged));
});

test("ordinary Foreman sessions are not customer investigations", () => {
  const ordinary = {
    attributes: {},
    authenticator: "slack",
    issuer: "foreman:slack",
    principalId: "U123",
    principalType: "user",
  } satisfies SessionAuthContext;
  assert.equal(isFinInvestigation(ordinary), false);
  assert.equal(finInvestigationContext(ordinary), null);
});
